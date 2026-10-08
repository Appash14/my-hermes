import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Configuration Capacitor — l'emballage de la PWA en APK Android.
 *
 * Deux façons de construire l'APK :
 *
 *  A. WebView distante (recommandé au début) — l'APK n'est qu'une coquille
 *     qui charge https://ton-domaine.com. Tu déploies le web, l'app est à
 *     jour sans repasser par le Play Store. C'est ce que fait `server.url`.
 *
 *  B. Bundle embarqué — `BUILD_TARGET=capacitor npm run build` produit un
 *     export statique dans `out/`, empaqueté dans l'APK. L'app démarre sans
 *     réseau, mais chaque mise à jour demande un nouvel APK. Pour ce mode,
 *     commente le bloc `server` ci-dessous.
 */
const config: CapacitorConfig = {
  appId: "com.hermes.app",
  appName: "Hermes",
  webDir: "out",

  server: {
    url: process.env.NEXT_PUBLIC_AGENT_URL ?? "https://hermes.exemple.com",
    // HTTPS obligatoire : sans lui Android bloque l'accès au micro.
    cleartext: false,
  },

  android: {
    // Empêche le fond blanc qui flashe au lancement.
    backgroundColor: "#0b0a09",
  },

  plugins: {
    // Sans cette permission, getUserMedia échoue silencieusement dans la
    // WebView Android — c'est le piège classique du mode vocal en APK.
    Permissions: {
      microphone: true,
    },
  },
};

export default config;
