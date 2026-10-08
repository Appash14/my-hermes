import { query } from "../db.js";
import type { ToolDefinition } from "../llm/types.js";

/**
 * Les outils que Hermes peut appeler.
 *
 * Pour en ajouter un : écris une entrée dans `registry` avec sa définition
 * (schéma JSON des paramètres) et son exécuteur. Rien d'autre à câbler —
 * la boucle agentique les découvre automatiquement.
 *
 * L'exécuteur reçoit les arguments déjà parsés et le contexte de l'appelant,
 * et renvoie une chaîne : c'est ce que le modèle lira comme résultat.
 */

export interface ToolContext {
  userId: string;
  conversationId: string;
}

interface Tool {
  definition: ToolDefinition;
  execute: (args: any, ctx: ToolContext) => Promise<string>;
}

const registry: Record<string, Tool> = {
  remember: {
    definition: {
      type: "function",
      function: {
        name: "remember",
        description:
          "Enregistre un fait durable sur l'utilisateur, à retenir entre les " +
          "conversations : une préférence, un projet en cours, une contrainte, " +
          "une personne de son entourage. N'enregistre PAS ce qui n'a d'intérêt " +
          "que pour la conversation en cours.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Le fait, formulé de façon autonome et compréhensible hors contexte. " +
                "Écris « Tom préfère les réponses courtes » plutôt que « il préfère ça ».",
            },
            kind: {
              type: "string",
              enum: ["preference", "fact", "project", "contact"],
              description: "La catégorie du fait.",
            },
          },
          required: ["content", "kind"],
        },
      },
    },
    async execute(args, ctx) {
      const content = String(args.content ?? "").trim();
      if (!content) return "Erreur : contenu vide, rien n'a été enregistré.";

      const kind = ["preference", "fact", "project", "contact"].includes(args.kind)
        ? args.kind
        : "fact";

      await query(
        `INSERT INTO memories (user_id, kind, content, source) VALUES ($1, $2, $3, $4)`,
        [ctx.userId, kind, content, ctx.conversationId],
      );
      return `Mémorisé (${kind}) : ${content}`;
    },
  },

  recall: {
    definition: {
      type: "function",
      function: {
        name: "recall",
        description:
          "Recherche dans la mémoire long terme ce qui a été retenu sur " +
          "l'utilisateur lors de conversations précédentes.",
        parameters: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description:
                "Mots-clés à rechercher. Laisse vide pour tout lister.",
            },
          },
          required: [],
        },
      },
    },
    async execute(args, ctx) {
      const search = String(args.search ?? "").trim();

      const rows = search
        ? await query<{ kind: string; content: string }>(
            `SELECT kind, content FROM memories
             WHERE user_id = $1 AND content ILIKE $2
             ORDER BY updated_at DESC LIMIT 30`,
            [ctx.userId, `%${search}%`],
          )
        : await query<{ kind: string; content: string }>(
            `SELECT kind, content FROM memories
             WHERE user_id = $1
             ORDER BY updated_at DESC LIMIT 30`,
            [ctx.userId],
          );

      if (rows.length === 0) {
        return search
          ? `Rien en mémoire pour « ${search} ».`
          : "La mémoire est vide.";
      }
      return rows.map((r) => `[${r.kind}] ${r.content}`).join("\n");
    },
  },

  forget: {
    definition: {
      type: "function",
      function: {
        name: "forget",
        description:
          "Supprime de la mémoire long terme un fait devenu faux ou obsolète. " +
          "À utiliser quand l'utilisateur corrige une information.",
        parameters: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Texte identifiant le souvenir à supprimer.",
            },
          },
          required: ["search"],
        },
      },
    },
    async execute(args, ctx) {
      const search = String(args.search ?? "").trim();
      if (!search) return "Erreur : il faut préciser quoi oublier.";

      const rows = await query<{ content: string }>(
        `DELETE FROM memories
         WHERE user_id = $1 AND content ILIKE $2
         RETURNING content`,
        [ctx.userId, `%${search}%`],
      );

      if (rows.length === 0) return `Aucun souvenir ne correspond à « ${search} ».`;
      return `Oublié : ${rows.map((r) => r.content).join(" ; ")}`;
    },
  },

  current_time: {
    definition: {
      type: "function",
      function: {
        name: "current_time",
        description:
          "Donne la date et l'heure actuelles. Le modèle n'a aucun moyen de " +
          "les connaître autrement — appelle cet outil dès qu'une réponse en dépend.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    async execute() {
      return new Date().toLocaleString("fr-FR", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: "Europe/Paris",
      });
    },
  },
};

export const toolDefinitions: ToolDefinition[] = Object.values(registry).map(
  (t) => t.definition,
);

/**
 * Exécute un outil demandé par le modèle.
 *
 * Ne lève jamais : une erreur d'outil est renvoyée au modèle comme un
 * résultat textuel, pour qu'il puisse s'adapter plutôt que de voir la
 * conversation s'arrêter net.
 */
export async function executeTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<string> {
  const tool = registry[name];
  if (!tool) return `Erreur : l'outil « ${name} » n'existe pas.`;

  let args: unknown;
  try {
    args = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    return `Erreur : arguments illisibles pour « ${name} » (JSON invalide).`;
  }

  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    return `Erreur pendant l'exécution de « ${name} » : ${(err as Error).message}`;
  }
}
