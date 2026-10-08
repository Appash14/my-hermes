import pg from "pg";
import { config } from "./config.js";
import type { ChatMessage } from "./llm/types.js";

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // 2 vCPU : inutile d'ouvrir des dizaines de connexions.
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("[db] erreur sur une connexion inactive :", err.message);
});

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

/** Vérifie que la base répond — utilisé par /api/health et au démarrage. */
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ── Utilisateur ──────────────────────────────────────────────

/**
 * En mono-utilisateur, tout passe par le compte `tom` créé par le schéma.
 * Quand tu passeras au multi-utilisateurs, c'est la seule fonction à
 * remplacer : tout le reste travaille déjà avec un userId.
 */
export async function getDefaultUserId(): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO users (handle) VALUES ('tom')
     ON CONFLICT (handle) DO UPDATE SET handle = EXCLUDED.handle
     RETURNING id`,
  );
  return rows[0]!.id;
}

// ── Conversations ────────────────────────────────────────────

export interface ConversationRow {
  id: string;
  title: string | null;
  mode: string;
  updated_at: string;
}

export async function createConversation(
  userId: string,
  mode: "text" | "voice",
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO conversations (user_id, mode) VALUES ($1, $2) RETURNING id`,
    [userId, mode],
  );
  return rows[0]!.id;
}

export async function listConversations(userId: string): Promise<ConversationRow[]> {
  return query<ConversationRow>(
    `SELECT id, title, mode, updated_at FROM conversations
     WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
    [userId],
  );
}

export async function setConversationTitle(id: string, title: string): Promise<void> {
  await query(`UPDATE conversations SET title = $2 WHERE id = $1`, [id, title.slice(0, 200)]);
}

export async function touchConversation(id: string): Promise<void> {
  await query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [id]);
}

// ── Messages ─────────────────────────────────────────────────

/**
 * On stocke le message complet en JSONB, pas seulement son texte : les
 * `tool_calls` et `tool_call_id` doivent survivre intacts, sinon l'historique
 * rejoué au modèle est invalide (un tool_call sans son résultat = requête rejetée).
 */
export async function saveMessage(
  conversationId: string,
  message: ChatMessage,
  usage?: { input?: number; output?: number },
): Promise<void> {
  const role = message.role === "tool" ? "system" : message.role;
  await query(
    `INSERT INTO messages (conversation_id, role, content, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      conversationId,
      role,
      JSON.stringify(message),
      usage?.input ?? null,
      usage?.output ?? null,
    ],
  );
}

export async function loadHistory(
  conversationId: string,
  limit = 100,
): Promise<ChatMessage[]> {
  const rows = await query<{ content: ChatMessage }>(
    `SELECT content FROM (
       SELECT content, created_at FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC LIMIT $2
     ) recent ORDER BY created_at ASC`,
    [conversationId, limit],
  );
  return rows.map((r) => r.content);
}

// ── Mémoire long terme ───────────────────────────────────────

/** Les faits injectés dans le prompt système à chaque tour. */
export async function loadMemories(userId: string, limit = 50): Promise<string[]> {
  const rows = await query<{ content: string }>(
    `SELECT content FROM memories WHERE user_id = $1
     ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => r.content);
}
