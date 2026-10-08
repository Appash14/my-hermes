import WebSocket from "ws";
import { config } from "../config.js";

/**
 * Speech-to-text en streaming via Deepgram.
 *
 * On ouvre une WebSocket vers Deepgram et on y pousse l'audio du micro au
 * fur et à mesure. Deepgram renvoie des transcriptions partielles (qui se
 * corrigent d'elles-mêmes) puis finales.
 *
 * Le signal qui nous intéresse vraiment est `speech_final` : Deepgram a
 * détecté une fin d'énoncé. C'est à ce moment qu'on lance l'agent, pas
 * avant — sinon on répond à une phrase coupée en deux.
 */

export interface SttCallbacks {
  /** Transcription encore susceptible de changer : à afficher en gris. */
  onPartial: (text: string) => void;
  /** L'utilisateur a fini de parler. C'est le déclencheur du tour d'agent. */
  onUtterance: (text: string) => void;
  onError: (message: string) => void;
}

export interface SttSession {
  /** Pousse un morceau d'audio brut (PCM 16 bits, 16 kHz, mono). */
  send: (audio: Buffer) => void;
  close: () => void;
}

export function openSttSession(callbacks: SttCallbacks): SttSession {
  const params = new URLSearchParams({
    model: "nova-3",
    language: "fr",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    // Ponctuation et mise en forme des nombres : indispensable, le texte
    // repart ensuite vers un LLM.
    smart_format: "true",
    interim_results: "true",
    // Silence (ms) au bout duquel Deepgram considère l'énoncé terminé.
    // Trop court = on coupe la parole ; trop long = ça traîne.
    endpointing: "400",
    utterance_end_ms: "1000",
  });

  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${config.DEEPGRAM_API_KEY}` },
  });

  // L'audio qui arrive avant l'ouverture effective de la socket serait perdu.
  const backlog: Buffer[] = [];
  let ready = false;

  // Deepgram ferme la connexion après ~10s sans trafic.
  const keepAlive = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, 8000);

  socket.on("open", () => {
    ready = true;
    for (const chunk of backlog) socket.send(chunk);
    backlog.length = 0;
  });

  socket.on("message", (raw) => {
    let data: any;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type !== "Results") return;

    const transcript: string = data.channel?.alternatives?.[0]?.transcript ?? "";
    if (transcript.trim() === "") return;

    if (data.speech_final) {
      callbacks.onUtterance(transcript);
    } else {
      callbacks.onPartial(transcript);
    }
  });

  socket.on("error", (err) => {
    callbacks.onError(`Deepgram : ${err.message}`);
  });

  socket.on("close", () => {
    clearInterval(keepAlive);
  });

  return {
    send(audio: Buffer) {
      if (!ready) {
        // Plafonné pour qu'une socket qui n'ouvre jamais ne gonfle pas la RAM.
        if (backlog.length < 200) backlog.push(audio);
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(audio);
    },
    close() {
      clearInterval(keepAlive);
      if (socket.readyState === WebSocket.OPEN) {
        // Demande à Deepgram de vider son tampon avant de fermer.
        socket.send(JSON.stringify({ type: "CloseStream" }));
      }
      socket.close();
    },
  };
}
