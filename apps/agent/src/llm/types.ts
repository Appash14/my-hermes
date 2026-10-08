/**
 * Types du protocole de chat, au format OpenAI — celui que parle OpenRouter,
 * et donc tous les modèles derrière (Claude, DeepSeek, GPT, Gemini, Llama...).
 *
 * C'est tout l'intérêt de la passerelle : un seul format à supporter côté
 * Hermes, quel que soit le modèle choisi dans l'app.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON sérialisé. Toujours parser, jamais faire du string matching dessus. */
    arguments: string;
  };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  /** Présent sur les messages `assistant` qui réclament un ou plusieurs outils. */
  tool_calls?: ToolCall[];
  /** Obligatoire sur les messages `tool` : relie le résultat à son appel. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema des paramètres. */
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Coût réel en dollars, calculé par OpenRouter. Absent chez certains providers. */
  cost?: number;
}

/** Événements émis par le stream. L'appelant fait un switch sur `type`. */
export type StreamEvent =
  | { type: "text"; delta: string }
  /**
   * Réflexion interne des modèles à raisonnement (DeepSeek V4, o-series...).
   * À afficher comme un indicateur, JAMAIS à envoyer à la synthèse vocale :
   * Hermes prononcerait ses propres pensées.
   */
  | { type: "reasoning"; delta: string }
  /** Émis une fois en fin de tour, avec tous les appels d'outils réassemblés. */
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; message: string };

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Coupe le raisonnement sur les modèles qui en font.
   *
   * Mesuré sur deepseek-v4-flash-0731 avec « Dis bonjour en une phrase » :
   *   - par défaut          : 178 tokens de raisonnement
   *   - {enabled: false}    : 0 token, même réponse
   *   - {effort: "low"}     : 807 tokens (!) et réponse vide — piège, ne pas utiliser
   *
   * On coupe en mode vocal (latence, et on ne prononce pas ses pensées) et
   * on garde en mode texte (meilleure qualité sur les questions difficiles).
   */
  disableReasoning?: boolean;
}

/** Une entrée du catalogue de modèles, telle qu'exposée à l'app. */
export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  /** Dollars par million de tokens, pour affichage. */
  pricePerMTokIn: number;
  pricePerMTokOut: number;
  supportsTools: boolean;
}
