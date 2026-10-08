"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchModels, type ModelInfo } from "@/lib/api";

/**
 * Sélecteur de modèle.
 *
 * La liste vient de l'API OpenRouter en direct — elle n'est pas codée en
 * dur, donc les nouveaux modèles apparaissent sans qu'on redéploie.
 *
 * Seuls les modèles supportant le tool calling sont proposés par défaut :
 * sans outils, Hermes perd sa mémoire et sa notion du temps. Une case à
 * cocher permet d'afficher les autres quand même.
 */

const MODEL_KEY = "hermes.model";

export function useSelectedModel() {
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    setModel(window.localStorage.getItem(MODEL_KEY) ?? "");
  }, []);

  const select = (id: string) => {
    setModel(id);
    window.localStorage.setItem(MODEL_KEY, id);
  };

  return { model, select };
}

export function ModelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchModels()
      .then((data) => {
        setModels(data.models);
        setDefaultModel(data.default);
      })
      .catch((err) => setError(err.message));
  }, []);

  const active = value || defaultModel;

  const filtered = useMemo(() => {
    const needle = search.toLowerCase();
    return models
      .filter((m) => showAll || m.supportsTools)
      .filter(
        (m) =>
          needle === "" ||
          m.id.toLowerCase().includes(needle) ||
          m.name.toLowerCase().includes(needle),
      )
      .slice(0, 60);
  }, [models, search, showAll]);

  const activeInfo = models.find((m) => m.id === active);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm text-bone-300 transition hover:border-ink-600 hover:text-bone-100"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="max-w-[45vw] truncate font-mono text-xs sm:max-w-xs">
          {activeInfo?.name ?? active ?? "Chargement…"}
        </span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden>
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <>
          {/* Clic à l'extérieur pour refermer */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />

          <div className="absolute right-0 z-20 mt-2 max-h-[70vh] w-[min(28rem,90vw)] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
            <div className="border-b border-ink-800 p-3">
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Chercher un modèle…"
                className="w-full rounded-lg bg-ink-800 px-3 py-2 text-sm outline-none ring-accent/40 placeholder:text-ink-600 focus:ring-2"
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-bone-500">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  className="accent-[--color-accent]"
                />
                Afficher aussi les modèles sans outils (pas de mémoire)
              </label>
            </div>

            {error && <p className="p-4 text-sm text-red-400">{error}</p>}

            <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-1">
              {filtered.map((m) => (
                <li key={m.id}>
                  <button
                    role="option"
                    aria-selected={m.id === active}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                    }}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition hover:bg-ink-800 ${
                      m.id === active ? "bg-ink-800 ring-1 ring-accent/40" : ""
                    }`}
                  >
                    <span className="text-sm text-bone-100">{m.name}</span>
                    <span className="font-mono text-[11px] text-bone-500">{m.id}</span>
                    <span className="text-[11px] text-ink-600">
                      {(m.contextLength / 1000).toFixed(0)}k contexte · $
                      {m.pricePerMTokIn.toFixed(2)} / ${m.pricePerMTokOut.toFixed(2)} par M
                      {!m.supportsTools && " · sans outils"}
                    </span>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && !error && (
                <li className="p-4 text-sm text-bone-500">Aucun modèle ne correspond.</li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
