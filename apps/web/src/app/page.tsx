"use client";

import { useEffect, useRef, useState } from "react";
import { ModelPicker, useSelectedModel } from "@/components/ModelPicker";
import { VoiceMode } from "@/components/VoiceMode";
import { getToken, login, sendChat } from "@/lib/api";

interface Message {
  role: "user" | "assistant";
  content: string;
  tool?: string;
  /** Le modèle raisonne : on l'indique sans afficher ses pensées. */
  thinking?: boolean;
}

export default function Home() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"text" | "voice">("text");
  const { model, select } = useSelectedModel();

  useEffect(() => {
    setAuthed(Boolean(getToken()));
  }, []);

  // `null` = on ne sait pas encore si le jeton existe (rendu serveur).
  if (authed === null) return null;
  if (!authed) return <LoginScreen onSuccess={() => setAuthed(true)} />;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="h-2 w-2 rounded-full bg-accent" />
          <h1 className="text-sm font-medium tracking-wide">Hermes</h1>
        </div>

        <div className="flex items-center gap-2">
          <ModelPicker value={model} onChange={select} />
          <div className="flex rounded-lg border border-ink-700 p-0.5">
            {(["text", "voice"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2.5 py-1 text-xs transition ${
                  mode === m
                    ? "bg-ink-700 text-bone-100"
                    : "text-bone-500 hover:text-bone-300"
                }`}
              >
                {m === "text" ? "Texte" : "Voix"}
              </button>
            ))}
          </div>
        </div>
      </header>

      {mode === "text" ? <TextMode model={model} /> : <VoiceMode model={model} />}
    </div>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(false);
    const ok = await login(code);
    setBusy(false);
    if (ok) onSuccess();
    else setError(true);
  };

  return (
    <main className="flex h-dvh items-center justify-center px-6">
      <form onSubmit={submit} className="w-full max-w-xs space-y-4">
        <div className="mb-8 flex items-center gap-3">
          <div className="h-2.5 w-2.5 rounded-full bg-accent" />
          <h1 className="text-lg tracking-wide">Hermes</h1>
        </div>

        <input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Code d'accès"
          autoComplete="current-password"
          className="w-full rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 outline-none ring-accent/40 focus:ring-2"
        />

        {error && <p className="text-sm text-red-400">Code invalide.</p>}

        <button
          type="submit"
          disabled={busy || !code}
          className="w-full rounded-lg bg-accent px-4 py-3 font-medium text-ink-950 transition disabled:opacity-40"
        >
          {busy ? "…" : "Entrer"}
        </button>
      </form>
    </main>
  );
}

function TextMode({ model }: { model: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);
    setStreaming(true);

    abort.current = new AbortController();

    await sendChat(
      {
        message: text,
        conversationId: conversationId.current,
        model: model || undefined,
        signal: abort.current.signal,
      },
      {
        onStart: (id) => (conversationId.current = id),
        onDelta: (delta) =>
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1]!;
            // Le premier fragment de réponse met fin à la phase de réflexion.
            next[next.length - 1] = {
              ...last,
              content: last.content + delta,
              thinking: false,
            };
            return next;
          }),
        onReasoning: () =>
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1]!;
            if (last.thinking) return prev;
            next[next.length - 1] = { ...last, thinking: true };
            return next;
          }),
        onTool: (name, status) =>
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1]!;
            next[next.length - 1] = {
              ...last,
              tool: status === "running" ? name : undefined,
            };
            return next;
          }),
        onError: (message) =>
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1]!;
            next[next.length - 1] = {
              ...last,
              content: last.content + `\n\n⚠ ${message}`,
            };
            return next;
          }),
      },
    );

    setStreaming(false);
  };

  return (
    <>
      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {messages.length === 0 && (
            <p className="pt-20 text-center text-sm text-ink-600">
              Écris quelque chose.
            </p>
          )}

          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-sm bg-ink-800 px-4 py-2.5 text-bone-100"
                    : "max-w-full whitespace-pre-wrap leading-relaxed text-bone-100"
                }
              >
                {m.content}
                {m.role === "assistant" && m.content === "" && !m.tool && (
                  <span className="flex items-center gap-2 text-sm text-bone-500">
                    <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse-soft" />
                    {m.thinking && "réfléchit…"}
                  </span>
                )}
                {m.tool && (
                  <span className="mt-2 block font-mono text-xs text-bone-500">
                    ⚙ {m.tool}…
                  </span>
                )}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </main>

      <footer className="border-t border-ink-800 px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Entrée envoie, Maj+Entrée passe à la ligne.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Message…"
            className="max-h-40 flex-1 resize-none rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 outline-none ring-accent/40 placeholder:text-ink-600 focus:ring-2"
          />
          {streaming ? (
            <button
              onClick={() => abort.current?.abort()}
              className="rounded-xl border border-ink-700 px-4 py-3 text-sm text-bone-300"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              className="rounded-xl bg-accent px-4 py-3 font-medium text-ink-950 transition disabled:opacity-30"
            >
              ↑
            </button>
          )}
        </div>
      </footer>
    </>
  );
}
