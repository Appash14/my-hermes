import { streamCompletion } from "../llm/openrouter.js";
import type { ChatMessage, ToolCall, Usage } from "../llm/types.js";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool, toolDefinitions, type ToolContext } from "./tools.js";

/**
 * La boucle agentique.
 *
 * Le principe est simple et tient en quatre temps :
 *   1. on envoie l'historique au modèle ;
 *   2. s'il réclame des outils, on les exécute ;
 *   3. on lui renvoie les résultats ;
 *   4. on recommence, jusqu'à ce qu'il réponde sans rien demander.
 *
 * Le garde-fou `MAX_ITERATIONS` évite qu'un modèle qui boucle sur lui-même
 * ne consomme le budget en silence.
 */

const MAX_ITERATIONS = 8;

export type AgentEvent =
  /** Fragment de texte destiné à l'utilisateur, à afficher au fil de l'eau. */
  | { type: "text"; delta: string }
  /** Réflexion interne. À afficher comme indicateur, jamais à prononcer. */
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_end"; name: string; result: string }
  /** Fin de tour : `messages` contient les nouveaux messages à persister. */
  | { type: "done"; messages: ChatMessage[]; usage: Usage | null }
  | { type: "error"; message: string };

export interface RunOptions {
  model: string;
  /** Historique de la conversation, message utilisateur courant inclus. */
  history: ChatMessage[];
  memories: string[];
  mode: "text" | "voice";
  ctx: ToolContext;
  signal?: AbortSignal;
}

export async function* runAgent(opts: RunOptions): AsyncGenerator<AgentEvent> {
  const system: ChatMessage = {
    role: "system",
    content: buildSystemPrompt({ memories: opts.memories, mode: opts.mode }),
  };

  // `working` est la conversation telle que la voit le modèle.
  const working: ChatMessage[] = [system, ...opts.history];
  // `produced` ne retient que ce qui est nouveau, pour la persistance.
  const produced: ChatMessage[] = [];
  let lastUsage: Usage | null = null;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let assistantText = "";
    let toolCalls: ToolCall[] = [];
    let failed = false;

    for await (const event of streamCompletion({
      model: opts.model,
      messages: working,
      tools: toolDefinitions,
      signal: opts.signal,
      // En vocal on coupe le raisonnement : il ajoute un blanc avant le
      // premier mot, et il n'a rien à faire dans la synthèse.
      disableReasoning: opts.mode === "voice",
    })) {
      switch (event.type) {
        case "text":
          assistantText += event.delta;
          yield { type: "text", delta: event.delta };
          break;
        case "reasoning":
          // Volontairement pas accumulé dans `assistantText` : la réflexion
          // ne fait pas partie de la réponse et n'est pas persistée.
          yield { type: "reasoning", delta: event.delta };
          break;
        case "tool_calls":
          toolCalls = event.calls;
          break;
        case "usage":
          lastUsage = event.usage;
          break;
        case "error":
          yield { type: "error", message: event.message };
          failed = true;
          break;
        case "done":
          break;
      }
      if (failed) return;
    }

    // Le tour du modèle, tel qu'il faut le lui rejouer ensuite.
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: assistantText || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    working.push(assistantMessage);
    produced.push(assistantMessage);

    // Aucun outil demandé : le modèle a fini de parler.
    if (toolCalls.length === 0) {
      yield { type: "done", messages: produced, usage: lastUsage };
      return;
    }

    // Les outils sont indépendants les uns des autres : on les exécute en
    // parallèle plutôt que d'additionner les latences.
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        const result = await executeTool(
          call.function.name,
          call.function.arguments,
          opts.ctx,
        );
        return { call, result };
      }),
    );

    for (const { call, result } of results) {
      yield { type: "tool_start", name: call.function.name, args: call.function.arguments };
      yield { type: "tool_end", name: call.function.name, result };

      // Chaque tool_call DOIT recevoir un message `tool` correspondant,
      // sinon la requête suivante est rejetée.
      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: call.id,
        content: result,
      };
      working.push(toolMessage);
      produced.push(toolMessage);
    }
  }

  yield {
    type: "error",
    message: `Arrêt après ${MAX_ITERATIONS} tours d'outils sans réponse finale.`,
  };
}
