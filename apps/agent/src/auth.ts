import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * Authentification mono-utilisateur : un code d'accès partagé, échangé
 * contre un jeton signé HMAC.
 *
 * Pas de base de sessions, pas de dépendance JWT : le jeton porte sa propre
 * date d'expiration et sa signature. Suffisant tant que Hermes n'a qu'un
 * utilisateur ; à remplacer par de vrais comptes le jour où il y en a plusieurs.
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function sign(payload: string): string {
  return createHmac("sha256", config.AUTH_SECRET).update(payload).digest("base64url");
}

/** Comparaison à temps constant : ne fuite pas la réponse par le timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function checkAccessCode(code: string): boolean {
  return safeEqual(code, config.HERMES_ACCESS_CODE);
}

export function issueToken(): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = String(expiresAt);
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;

  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  if (!safeEqual(signature, sign(payload))) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

/**
 * Extrait le jeton d'une requête. Le WebSocket ne peut pas porter d'en-tête
 * Authorization depuis un navigateur, d'où le repli sur la query string.
 */
export function extractToken(headers: Record<string, unknown>, url: string): string | undefined {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  try {
    return new URL(url, "http://localhost").searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}
