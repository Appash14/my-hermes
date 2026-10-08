import type { FastifyInstance } from "fastify";
import { runAgent } from "../agent/loop.js";
import { extractToken, verifyToken } from "../auth.js";
import { config, voiceEnabled } from "../config.js";
import {
  createConversation,
  getDefaultUserId,
  loadHistory,
  loadMemories,
  saveMessage,
  touchConversation,
} from "../db.js";
import type { ChatMessage } from "../llm/types.js";
import { openSttSession } from "../voice/stt.js";
import { SentenceBuffer, streamSpeech } from "../voice/tts.js";

/**
 * Le mode vocal, de bout en bout.
 *
 *   micro navigateur ──audio PCM──▶ Deepgram ──texte──▶ agent
 *                                                         │
 *   haut-parleur  ◀──audio MP3──── ElevenLabs ◀──texte────┘
 *
 * Tout transite par une seule WebSocket. Les messages texte sont du JSON
 * (transcriptions, statuts), les messages binaires sont de l'audio : montant
 * = micro, descendant = voix de Hermes.
 */

export async function registerVoiceRoute(app: FastifyInstance): Promise<void> {
  app.get("/ws/voice", { websocket: true }, async (socket, request) => {
    const token = extractToken(
      request.headers as Record<string, unknown>,
      request.url,
    );
    if (!verifyToken(token)) {
      socket.close(4401, "Non authentifié");
      return;
    }

    if (!voiceEnabled) {
      socket.close(4503, "Mode vocal non configuré (clés STT/TTS manquantes)");
      return;
    }

    const say = (type: string, payload: Record<string, unknown> = {}) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type, ...payload }));
      }
    };

    const userId = await getDefaultUserId();
    const conversationId = await createConversation(userId, "voice");
    say("ready", { conversationId });

    // Un seul tour d'agent à la fois. Si l'utilisateur reparle pendant que
    // Hermes répond, on annule le tour en cours : il vient de l'interrompre.
    let turn: AbortController | null = null;
    let model = config.HERMES_DEFAULT_MODEL;
    let closed = false;

    const stt = openSttSession({
      onPartial(text) {
        say("transcript", { text, final: false });
      },
      onUtterance(text) {
        say("transcript", { text, final: true });
        void handleUtterance(text);
      },
      onError(message) {
        say("error", { message });
      },
    });

    async function handleUtterance(text: string): Promise<void> {
      // Interruption : l'utilisateur a repris la parole.
      if (turn) {
        turn.abort();
        say("interrupted");
      }

      const controller = new AbortController();
      turn = controller;

      const userMessage: ChatMessage = { role: "user", content: text };
      const history = await loadHistory(conversationId);
      await saveMessage(conversationId, userMessage);
      const memories = await loadMemories(userId);

      const sentences = new SentenceBuffer();
      say("thinking");

      // La synthèse est sérialisée : les fragments doivent être prononcés
      // dans l'ordre, sinon la phrase part en morceaux mélangés.
      let speaking: Promise<void> = Promise.resolve();

      const speak = (fragment: string) => {
        speaking = speaking.then(async () => {
          if (controller.signal.aborted) return;
          try {
            for await (const chunk of streamSpeech(fragment, controller.signal)) {
              if (controller.signal.aborted) return;
              if (socket.readyState === socket.OPEN) socket.send(chunk);
            }
          } catch (err) {
            if (!controller.signal.aborted) {
              say("error", { message: `Synthèse vocale : ${(err as Error).message}` });
            }
          }
        });
      };

      try {
        for await (const event of runAgent({
          model,
          history: [...history, userMessage],
          memories,
          mode: "voice",
          ctx: { userId, conversationId },
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;

          switch (event.type) {
            case "text":
              say("delta", { text: event.delta });
              // Dès qu'une phrase est complète, on la fait parler — sans
              // attendre la fin de la réponse.
              for (const fragment of sentences.push(event.delta)) speak(fragment);
              break;
            case "tool_start":
              say("tool", { name: event.name });
              break;
            case "done": {
              const rest = sentences.flush();
              if (rest) speak(rest);
              for (const m of event.messages) {
                await saveMessage(conversationId, m, {
                  input: event.usage?.prompt_tokens,
                  output: event.usage?.completion_tokens,
                });
              }
              await touchConversation(conversationId);
              break;
            }
            case "error":
              say("error", { message: event.message });
              break;
          }
        }

        await speaking;
        if (!controller.signal.aborted) say("turn_end");
      } catch (err) {
        if (!controller.signal.aborted) {
          say("error", { message: (err as Error).message });
        }
      } finally {
        if (turn === controller) turn = null;
      }
    }

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (closed) return;

      // Binaire = audio du micro, à pousser tel quel vers Deepgram.
      if (isBinary) {
        stt.send(data);
        return;
      }

      // Texte = commande de contrôle.
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "set_model":
          if (typeof msg.model === "string" && msg.model) {
            model = msg.model;
            say("model_changed", { model });
          }
          break;
        case "stop":
          // Bouton « stop » : coupe Hermes au milieu de sa phrase.
          if (turn) {
            turn.abort();
            turn = null;
            say("interrupted");
          }
          break;
      }
    });

    socket.on("close", () => {
      closed = true;
      turn?.abort();
      stt.close();
    });

    socket.on("error", () => {
      closed = true;
      turn?.abort();
      stt.close();
    });
  });
}
