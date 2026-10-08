/** Client HTTP de l'agent : authentification, catalogue de modèles, chat SSE. */

/**
 * Base de l'API.
 *
 * Non renseignée (cas du déploiement où Caddy sert le front et l'agent sous
 * le même domaine), on retombe sur l'origine de la page. Le test `||` plutôt
 * que `??` est délibéré : la variable vaut la chaîne vide, pas `undefined`,
 * quand elle est passée vide au build.
 */
const AGENT_URL =
  process.env.NEXT_PUBLIC_AGENT_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");

const TOKEN_KEY = "hermes.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function login(code: string): Promise<boolean> {
  const response = await fetch(`${AGENT_URL}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) return false;
  const { token } = await response.json();
  setToken(token);
  return true;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  pricePerMTokIn: number;
  pricePerMTokOut: number;
  supportsTools: boolean;
}

export async function fetchModels(): Promise<{ models: ModelInfo[]; default: string }> {
  const response = await fetch(`${AGENT_URL}/api/models`, { headers: authHeaders() });
  if (!response.ok) throw new Error("Catalogue de modèles indisponible");
  return response.json();
}

export interface ChatCallbacks {
  onStart?: (conversationId: string) => void;
  onDelta: (text: string) => void;
  /** Modèles à raisonnement : sert à afficher un indicateur, pas le texte. */
  onReasoning?: (text: string) => void;
  onTool?: (name: string, status: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * Envoie un message et consomme la réponse en streaming.
 *
 * On lit le flux SSE à la main plutôt qu'avec EventSource : celui-ci ne
 * sait faire que des GET, et ne permet pas d'envoyer d'en-tête
 * d'authentification.
 */
export async function sendChat(
  params: {
    message: string;
    conversationId?: string;
    model?: string;
    signal?: AbortSignal;
  },
  callbacks: ChatCallbacks,
): Promise<void> {
  const response = await fetch(`${AGENT_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      message: params.message,
      conversationId: params.conversationId,
      model: params.model,
      mode: "text",
    }),
    signal: params.signal,
  });

  if (!response.ok || !response.body) {
    callbacks.onError?.(`Erreur ${response.status}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Un événement SSE se termine par une ligne vide ; un paquet réseau
    // peut couper n'importe où, d'où le buffer.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let eventName = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      switch (eventName) {
        case "start":
          callbacks.onStart?.(payload.conversationId);
          break;
        case "delta":
          callbacks.onDelta(payload.text);
          break;
        case "reasoning":
          callbacks.onReasoning?.(payload.text);
          break;
        case "tool":
          callbacks.onTool?.(payload.name, payload.status);
          break;
        case "done":
          callbacks.onDone?.();
          break;
        case "error":
          callbacks.onError?.(payload.message);
          break;
      }
    }
  }
}

export function voiceSocketUrl(): string {
  // Une WebSocket exige une URL absolue : jamais de chemin relatif ici.
  const origin = AGENT_URL || window.location.origin;
  const base = origin.replace(/^http/, "ws");
  return `${base}/ws/voice?token=${encodeURIComponent(getToken() ?? "")}`;
}
