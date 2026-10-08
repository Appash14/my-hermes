import { config } from "../config.js";

/**
 * Text-to-speech en streaming via ElevenLabs.
 *
 * On récupère l'audio par morceaux et on les relaie au navigateur au fil de
 * l'eau : Hermes commence à parler avant d'avoir fini de générer la phrase.
 * Attendre l'audio complet ajouterait une seconde de silence à chaque tour.
 */

/** Modèle le plus rapide d'ElevenLabs (~75ms), au prix d'un peu d'expressivité. */
const TTS_MODEL = "eleven_flash_v2_5";

export async function* streamSpeech(
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const trimmed = text.trim();
  if (trimmed === "") return;

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID}/stream` +
    `?output_format=mp3_44100_128`;

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "xi-api-key": config.ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: trimmed,
      model_id: TTS_MODEL,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        speed: 1.0,
      },
    }),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs ${response.status}: ${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Découpe le flux de texte du LLM en fragments prononçables.
 *
 * Le LLM produit du texte token par token, mais on ne peut pas envoyer
 * « Bon » puis « jour » à la synthèse : elle prononcerait deux mots. On
 * accumule donc jusqu'à une frontière naturelle — fin de phrase, ou virgule
 * si le fragment est déjà assez long.
 */
export class SentenceBuffer {
  private buffer = "";

  /** Longueur au-delà de laquelle une virgule suffit à découper. */
  private static readonly SOFT_BREAK_MIN = 80;

  /** Ajoute du texte et renvoie les fragments prêts à être prononcés. */
  push(delta: string): string[] {
    this.buffer += delta;
    const ready: string[] = [];

    while (true) {
      const cut = this.findCut(this.buffer);
      if (cut === -1) break;
      const fragment = this.buffer.slice(0, cut + 1).trim();
      this.buffer = this.buffer.slice(cut + 1);
      if (fragment) ready.push(fragment);
    }

    return ready;
  }

  /** À appeler en fin de tour pour récupérer le reste. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }

  private findCut(text: string): number {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;

      if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
        // Un point suivi d'un chiffre est probablement une décimale
        // ou une énumération — pas une fin de phrase.
        const next = text[i + 1];
        if (ch === "." && next && /[0-9]/.test(next)) continue;
        return i;
      }

      if ((ch === "," || ch === ";" || ch === ":") && i >= SentenceBuffer.SOFT_BREAK_MIN) {
        return i;
      }
    }
    return -1;
  }
}
