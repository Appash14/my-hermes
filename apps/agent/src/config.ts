import { z } from "zod";

/**
 * Toute la configuration passe par l'environnement et est validée au
 * démarrage. Si une variable obligatoire manque, le service refuse de
 * démarrer avec un message clair — plutôt que de planter au premier appel.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),

  // Cerveau
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY est obligatoire"),
  HERMES_DEFAULT_MODEL: z.string().default("deepseek/deepseek-v4-flash-0731"),
  HERMES_UTILITY_MODEL: z.string().default("deepseek/deepseek-v4-flash-0731"),
  OPENROUTER_SITE_URL: z.string().optional(),
  OPENROUTER_SITE_NAME: z.string().default("Hermes"),

  // Voix — facultatives : sans elles le mode texte marche quand même,
  // seul le mode vocal est désactivé.
  DEEPGRAM_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),

  // Stockage
  DATABASE_URL: z.string().min(1, "DATABASE_URL est obligatoire"),
  REDIS_URL: z.string().default("redis://redis:6379"),

  // Auth
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET doit faire au moins 16 caractères"),
  HERMES_ACCESS_CODE: z.string().min(1, "HERMES_ACCESS_CODE est obligatoire"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Configuration invalide :");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

/** Le mode vocal exige les deux briques : écoute et parole. */
export const voiceEnabled = Boolean(
  config.DEEPGRAM_API_KEY && config.ELEVENLABS_API_KEY && config.ELEVENLABS_VOICE_ID,
);
