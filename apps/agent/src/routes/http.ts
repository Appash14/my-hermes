import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { runAgent } from "../agent/loop.js";
import { checkAccessCode, issueToken, verifyToken } from "../auth.js";
import { config, voiceEnabled } from "../config.js";
import {
  createConversation,
  getDefaultUserId,
  listConversations,
  loadHistory,
  loadMemories,
  pingDb,
  saveMessage,
  setConversationTitle,
  touchConversation,
} from "../db.js";
import { complete, listModels } from "../llm/openrouter.js";
import type { ChatMessage } from "../llm/types.js";

/** Cache du catalogue de modèles : la liste bouge peu, l'appel coûte ~300ms. */
let modelCache: { at: number; data: unknown } | null = null;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!verifyToken(token)) {
    reply.code(401).send({ error: "Non authentifié" });
    return false;
  }
  return true;
}

const chatBody = z.object({
  message: z.string().min(1, "Message vide"),
  conversationId: z.string().uuid().optional(),
  model: z.string().optional(),
  mode: z.enum(["text", "voice"]).default("text"),
});

export async function registerHttpRoutes(app: FastifyInstance): Promise<void> {
  // ── Santé ──────────────────────────────────────────────────
  app.get("/api/health", async () => ({
    ok: true,
    db: await pingDb(),
    voice: voiceEnabled,
    defaultModel: config.HERMES_DEFAULT_MODEL,
  }));

  // ── Authentification ───────────────────────────────────────
  app.post("/api/auth", async (request, reply) => {
    const parsed = z.object({ code: z.string() }).safeParse(request.body);
    if (!parsed.success || !checkAccessCode(parsed.data.code)) {
      // Délai fixe : ne distingue pas « code faux » de « corps invalide ».
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: "Code d'accès invalide" });
    }
    return { token: issueToken() };
  });

  // ── Catalogue de modèles ───────────────────────────────────
  // C'est ce qui alimente le sélecteur de modèle dans l'app.
  app.get("/api/models", async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) {
      return { models: modelCache.data, default: config.HERMES_DEFAULT_MODEL };
    }

    try {
      const models = await listModels();
      modelCache = { at: Date.now(), data: models };
      return { models, default: config.HERMES_DEFAULT_MODEL };
    } catch (err) {
      return reply
        .code(502)
        .send({ error: `Catalogue indisponible : ${(err as Error).message}` });
    }
  });

  // ── Conversations ──────────────────────────────────────────
  app.get("/api/conversations", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const userId = await getDefaultUserId();
    return { conversations: await listConversations(userId) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      return { messages: await loadHistory(request.params.id) };
    },
  );

  // ── Chat en streaming (SSE) ────────────────────────────────
  app.post("/api/chat", async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const parsed = chatBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    }
    const { message, model, mode } = parsed.data;

    const userId = await getDefaultUserId();
    const conversationId =
      parsed.data.conversationId ?? (await createConversation(userId, mode));

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Désactive le buffering d'éventuels proxys intermédiaires.
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("start", { conversationId });

    // Si le client ferme l'onglet, on arrête de payer des tokens.
    const abort = new AbortController();
    request.raw.on("close", () => abort.abort());

    const userMessage: ChatMessage = { role: "user", content: message };
    const history = await loadHistory(conversationId);
    await saveMessage(conversationId, userMessage);

    const memories = await loadMemories(userId);
    let fullText = "";

    try {
      for await (const event of runAgent({
        model: model ?? config.HERMES_DEFAULT_MODEL,
        history: [...history, userMessage],
        memories,
        mode,
        ctx: { userId, conversationId },
        signal: abort.signal,
      })) {
        switch (event.type) {
          case "text":
            fullText += event.delta;
            send("delta", { text: event.delta });
            break;
          case "reasoning":
            // Le client n'affiche qu'un indicateur « réfléchit » ; on
            // envoie quand même le texte, utile pour déboguer un modèle
            // qui part en vrille.
            send("reasoning", { text: event.delta });
            break;
          case "tool_start":
            send("tool", { name: event.name, status: "running" });
            break;
          case "tool_end":
            send("tool", { name: event.name, status: "done" });
            break;
          case "done":
            for (const m of event.messages) {
              await saveMessage(conversationId, m, {
                input: event.usage?.prompt_tokens,
                output: event.usage?.completion_tokens,
              });
            }
            await touchConversation(conversationId);
            send("done", { usage: event.usage ?? null });
            break;
          case "error":
            send("error", { message: event.message });
            break;
        }
      }
    } catch (err) {
      send("error", { message: (err as Error).message });
    }

    reply.raw.end();

    // Titre de la conversation, généré après coup pour ne pas retarder la
    // réponse. Best-effort : un échec ici n'a aucune conséquence.
    if (!parsed.data.conversationId && fullText) {
      void generateTitle(conversationId, message, fullText).catch(() => {});
    }
  });
}

async function generateTitle(
  conversationId: string,
  question: string,
  answer: string,
): Promise<void> {
  const title = await complete(
    config.HERMES_UTILITY_MODEL,
    [
      {
        role: "user",
        content:
          "Résume cet échange en un titre de 3 à 6 mots, sans guillemets " +
          `ni ponctuation finale.\n\nQ: ${question}\nR: ${answer.slice(0, 400)}`,
      },
    ],
    32,
  );
  const clean = title.trim().replace(/^["']|["'.]$/g, "");
  if (clean) await setConversationTitle(conversationId, clean);
}
