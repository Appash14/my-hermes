"use client";

import { useEffect, useRef, useState } from "react";
import { VoiceSession, type VoiceState } from "@/lib/voice";

/**
 * Mode vocal : un gros bouton, une transcription en direct, la réponse
 * de Hermes affichée pendant qu'il la prononce.
 *
 * Pas de bouton « parler » à maintenir enfoncé : c'est Deepgram qui
 * détecte les fins de phrase. On appuie une fois pour ouvrir le micro,
 * une fois pour le fermer.
 */

const LABEL: Record<VoiceState, string> = {
  idle: "Appuie pour parler",
  connecting: "Connexion…",
  listening: "Je t'écoute",
  thinking: "Je réfléchis…",
  speaking: "…",
};

export function VoiceMode({ model }: { model: string }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const [partial, setPartial] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const session = useRef<VoiceSession | null>(null);

  // Fermer le micro si on quitte l'écran : sinon la piste reste active
  // et le voyant du micro reste allumé.
  useEffect(() => () => session.current?.stop(), []);

  useEffect(() => {
    if (model) session.current?.setModel(model);
  }, [model]);

  const toggle = async () => {
    if (state !== "idle") {
      session.current?.stop();
      session.current = null;
      return;
    }

    setError(null);
    setReply("");
    setTranscript("");

    session.current = new VoiceSession({
      onState: setState,
      onTranscript: (text, final) => {
        if (final) {
          setTranscript(text);
          setPartial("");
          setReply("");
        } else {
          setPartial(text);
        }
      },
      onDelta: (delta) => setReply((prev) => prev + delta),
      onError: setError,
    });

    await session.current.start(model || undefined);
  };

  const active = state !== "idle";

  return (
    <main className="flex flex-1 flex-col items-center justify-between px-6 py-10">
      {/* Zone de conversation */}
      <div className="flex w-full max-w-lg flex-1 flex-col justify-center gap-6 text-center">
        {(transcript || partial) && (
          <p className="text-sm text-bone-500">
            {transcript}
            {partial && <span className="text-ink-600"> {partial}</span>}
          </p>
        )}

        {reply && (
          <p className="text-lg leading-relaxed text-bone-100">{reply}</p>
        )}

        {!transcript && !reply && !error && (
          <p className="text-sm text-ink-600">
            {active ? "Vas-y, parle." : "Le mode vocal a besoin du micro et d'une connexion HTTPS."}
          </p>
        )}

        {error && (
          <p className="mx-auto max-w-sm text-sm text-red-400">{error}</p>
        )}
      </div>

      {/* Bouton micro */}
      <div className="flex flex-col items-center gap-4">
        <button
          onClick={() => void toggle()}
          aria-label={active ? "Fermer le micro" : "Ouvrir le micro"}
          className={`flex h-24 w-24 items-center justify-center rounded-full transition ${
            active
              ? "bg-accent text-ink-950 animate-breathe"
              : "border-2 border-ink-700 text-bone-500 hover:border-accent hover:text-accent"
          }`}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
            <path
              d="M5 11a7 7 0 0014 0M12 18v4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <p className="text-sm text-bone-500">{LABEL[state]}</p>

        {state === "speaking" && (
          <button
            onClick={() => session.current?.interrupt()}
            className="rounded-lg border border-ink-700 px-4 py-1.5 text-xs text-bone-300"
          >
            Coupe-le
          </button>
        )}
      </div>
    </main>
  );
}
