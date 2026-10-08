import { config } from "../config.js";
import type {
  ChatMessage,
  CompletionRequest,
  ModelInfo,
  StreamEvent,
  ToolCall,
  Usage,
} from "./types.js";

const BASE_URL = "https://openrouter.ai/api/v1";

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  // Attribution facultative dans les classements OpenRouter.
  if (config.OPENROUTER_SITE_URL) h["HTTP-Referer"] = config.OPENROUTER_SITE_URL;
  h["X-Title"] = config.OPENROUTER_SITE_NAME;
  return h;
}

/**
 * Appelle le modèle en streaming et émet des événements au fil de l'eau.
 *
 * Le flux SSE d'OpenRouter arrive par paquets réseau qui ne s'alignent pas
 * sur les frontières de lignes : un `data:` peut être coupé en deux. On
 * bufferise donc jusqu'au `\n\n` qui termine chaque événement.
 */
export async function* streamCompletion(
  req: CompletionRequest,
): AsyncGenerator<StreamEvent> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        tools: req.tools,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? 4096,
        stream: true,
        // Demande le décompte de tokens et le coût dans le dernier chunk.
        stream_options: { include_usage: true },
        // Ignoré par les modèles sans raisonnement — inoffensif de l'envoyer.
        ...(req.disableReasoning ? { reasoning: { enabled: false } } : {}),
      }),
    });
  } catch (err) {
    yield {
      type: "error",
      message: `Impossible de joindre OpenRouter : ${(err as Error).message}`,
    };
    return;
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    yield {
      type: "error",
      message: `OpenRouter a répondu ${response.status}: ${detail.slice(0, 500)}`,
    };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Les appels d'outils arrivent en morceaux, répartis sur plusieurs chunks
  // et identifiés par leur `index`. On les réassemble ici.
  const pendingCalls = new Map<number, ToolCall>();
  let finishReason: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Un événement SSE se termine par une ligne vide.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" ) continue;
          if (payload === "[DONE]") continue;

          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            // OpenRouter insère parfois des commentaires de keep-alive.
            continue;
          }

          if (chunk.error) {
            yield { type: "error", message: String(chunk.error.message ?? chunk.error) };
            return;
          }

          const choice = chunk.choices?.[0];
          if (choice) {
            const delta = choice.delta ?? {};

            // Les modèles à raisonnement émettent leur réflexion sur un
            // canal distinct. Ne jamais la confondre avec la réponse.
            if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
              yield { type: "reasoning", delta: delta.reasoning };
            }

            if (typeof delta.content === "string" && delta.content.length > 0) {
              yield { type: "text", delta: delta.content };
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx: number = tc.index ?? 0;
                const existing = pendingCalls.get(idx) ?? {
                  id: "",
                  type: "function" as const,
                  function: { name: "", arguments: "" },
                };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name = tc.function.name;
                if (tc.function?.arguments) {
                  // Les arguments arrivent en fragments à concaténer.
                  existing.function.arguments += tc.function.arguments;
                }
                pendingCalls.set(idx, existing);
              }
            }

            if (choice.finish_reason) finishReason = choice.finish_reason;
          }

          if (chunk.usage) {
            yield { type: "usage", usage: chunk.usage as Usage };
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      yield { type: "done", finishReason: "aborted" };
      return;
    }
    yield { type: "error", message: `Flux interrompu : ${(err as Error).message}` };
    return;
  } finally {
    reader.releaseLock();
  }

  if (pendingCalls.size > 0) {
    // Ordonner par index : l'ordre des appels compte pour le modèle.
    const calls = [...pendingCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
    yield { type: "tool_calls", calls };
  }

  yield { type: "done", finishReason };
}

/** Appel non streamé, pour les tâches internes courtes (titres, résumés). */
export async function complete(
  model: string,
  messages: ChatMessage[],
  maxTokens = 256,
): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream: false,
      // Tâches internes (titres, résumés) : le raisonnement coûterait dix
      // fois le prix de la réponse pour aucun gain.
      reasoning: { enabled: false },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Catalogue des modèles disponibles. C'est ce qui alimente le sélecteur
 * de modèle dans l'app — la liste est vivante, pas codée en dur.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const response = await fetch(`${BASE_URL}/models`, { headers: headers() });
  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }

  const data: any = await response.json();

  return (data.data ?? []).map((m: any): ModelInfo => {
    // La tarification OpenRouter est en dollars par token. On convertit en
    // dollars par million, la seule unité lisible pour un humain.
    const priceIn = Number(m.pricing?.prompt ?? 0) * 1_000_000;
    const priceOut = Number(m.pricing?.completion ?? 0) * 1_000_000;
    return {
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? 0,
      pricePerMTokIn: Number(priceIn.toFixed(4)),
      pricePerMTokOut: Number(priceOut.toFixed(4)),
      // Sans support des outils, Hermes ne peut pas agir — seulement discuter.
      supportsTools: Array.isArray(m.supported_parameters)
        ? m.supported_parameters.includes("tools")
        : false,
    };
  });
}
