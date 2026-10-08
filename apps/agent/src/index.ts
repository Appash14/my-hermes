import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config, voiceEnabled } from "./config.js";
import { closeDb, pingDb } from "./db.js";
import { registerHttpRoutes } from "./routes/http.js";
import { registerVoiceRoute } from "./routes/voice.js";

const app = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    transport:
      config.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { colorize: true } },
  },
  // Caddy est devant : on lui fait confiance pour X-Forwarded-*.
  trustProxy: true,
});

await app.register(cors, {
  // En production, tout passe par le même domaine via Caddy, donc les
  // requêtes sont same-origin. CORS n'est ouvert qu'en développement,
  // où le front tourne sur un port différent.
  origin: config.NODE_ENV === "production" ? false : true,
  credentials: true,
});

await app.register(websocket, {
  options: {
    // L'audio PCM arrive en petits paquets ; 1 Mo est large.
    maxPayload: 1024 * 1024,
  },
});

await registerHttpRoutes(app);
await registerVoiceRoute(app);

// Attendre Postgres : au premier `docker compose up`, la base peut mettre
// quelques secondes à accepter des connexions même après le healthcheck.
for (let attempt = 1; attempt <= 10; attempt++) {
  if (await pingDb()) break;
  app.log.warn(`Base indisponible, nouvelle tentative (${attempt}/10)…`);
  await new Promise((r) => setTimeout(r, 2000));
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} reçu, arrêt en cours…`);
  await app.close();
  await closeDb();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: "0.0.0.0" });

app.log.info(
  `Hermes agent démarré — modèle par défaut : ${config.HERMES_DEFAULT_MODEL}, ` +
    `mode vocal : ${voiceEnabled ? "actif" : "désactivé (clés manquantes)"}`,
);
