import { voiceSocketUrl } from "./api";

/**
 * Session vocale côté navigateur.
 *
 *   micro ──▶ AudioWorklet (PCM 16 bits) ──▶ WebSocket ──▶ agent
 *   haut-parleur ◀── MediaSource (MP3) ◀── WebSocket ◀── agent
 *
 * Note : `getUserMedia` n'existe que sur une origine sécurisée. En HTTP,
 * l'appel échoue — d'où le HTTPS obligatoire sur le VPS.
 */

export type VoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

export interface VoiceHandlers {
  onState: (state: VoiceState) => void;
  onTranscript: (text: string, final: boolean) => void;
  onDelta: (text: string) => void;
  onError: (message: string) => void;
}

export class VoiceSession {
  private socket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  // Lecture de la voix de Hermes
  private audio: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];

  constructor(private handlers: VoiceHandlers) {}

  async start(model?: string): Promise<void> {
    this.handlers.onState("connecting");

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      this.handlers.onError(
        "Micro inaccessible. Vérifie l'autorisation du navigateur, et que la page est bien en HTTPS.",
      );
      this.handlers.onState("idle");
      return;
    }

    // 16 kHz demandé directement au contexte : c'est le navigateur qui
    // rééchantillonne, avec une bien meilleure qualité qu'un filtre maison.
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    await this.audioContext.audioWorklet.addModule("/pcm-worklet.js");

    this.socket = new WebSocket(voiceSocketUrl());
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      if (model) this.socket?.send(JSON.stringify({ type: "set_model", model }));
      this.handlers.onState("listening");
    };

    this.socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.handleControlMessage(JSON.parse(event.data));
      } else {
        this.enqueueAudio(event.data as ArrayBuffer);
      }
    };

    this.socket.onerror = () => this.handlers.onError("Connexion vocale perdue.");
    this.socket.onclose = (event) => {
      if (event.code === 4401) this.handlers.onError("Session expirée, reconnecte-toi.");
      else if (event.code === 4503) this.handlers.onError("Mode vocal non configuré côté serveur.");
      this.handlers.onState("idle");
    };

    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.audioContext, "pcm-processor");

    this.node.port.onmessage = (event) => {
      const pcm = event.data as Int16Array;
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(pcm.buffer);
      }
    };

    source.connect(this.node);
    // Le worklet ne produit pas de son ; on ne le connecte PAS à la
    // destination, sinon on s'entendrait parler en écho.

    this.setupPlayback();
  }

  private handleControlMessage(msg: any): void {
    switch (msg.type) {
      case "transcript":
        this.handlers.onTranscript(msg.text, msg.final);
        break;
      case "thinking":
        this.handlers.onState("thinking");
        break;
      case "delta":
        this.handlers.onDelta(msg.text);
        this.handlers.onState("speaking");
        break;
      case "turn_end":
        this.handlers.onState("listening");
        break;
      case "interrupted":
        this.resetPlayback();
        this.handlers.onState("listening");
        break;
      case "error":
        this.handlers.onError(msg.message);
        break;
    }
  }

  // ── Lecture audio ────────────────────────────────────────
  // Les morceaux MP3 arrivent au fil de l'eau. MediaSource permet de les
  // jouer à mesure, sans attendre la fin de la phrase.

  private setupPlayback(): void {
    this.audio = new Audio();
    this.mediaSource = new MediaSource();
    this.audio.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener("sourceopen", () => {
      if (!this.mediaSource) return;
      this.sourceBuffer = this.mediaSource.addSourceBuffer("audio/mpeg");
      this.sourceBuffer.addEventListener("updateend", () => this.drainQueue());
      this.drainQueue();
    });

    void this.audio.play().catch(() => {
      // Certains navigateurs exigent une interaction avant de jouer du son.
      // Le clic sur le bouton micro fait office d'interaction, donc en
      // pratique on ne passe pas ici.
    });
  }

  private enqueueAudio(chunk: ArrayBuffer): void {
    this.queue.push(chunk);
    this.drainQueue();
  }

  private drainQueue(): void {
    // SourceBuffer n'accepte qu'un append à la fois : d'où la file.
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) {
      return;
    }
    const chunk = this.queue.shift()!;
    try {
      this.sourceBuffer.appendBuffer(chunk);
    } catch {
      // Buffer saturé : on repart proprement plutôt que de bloquer la session.
      this.resetPlayback();
    }
  }

  /** Coupe le son immédiatement — utilisé quand l'utilisateur interrompt. */
  private resetPlayback(): void {
    this.queue = [];
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
    }
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.setupPlayback();
  }

  /** Bouton stop : coupe Hermes au milieu de sa phrase. */
  interrupt(): void {
    this.socket?.send(JSON.stringify({ type: "stop" }));
    this.resetPlayback();
  }

  setModel(model: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "set_model", model }));
    }
  }

  stop(): void {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.audioContext?.close();
    this.socket?.close();
    this.queue = [];
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
    }
    this.handlers.onState("idle");
  }
}
