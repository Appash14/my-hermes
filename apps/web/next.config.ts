import type { NextConfig } from "next";

const config: NextConfig = {
  // `standalone` produit un serveur Node minimal dans .next/standalone :
  // l'image Docker n'embarque alors ni les sources ni node_modules complet.
  output: "standalone",

  // Capacitor a besoin d'un export statique pour empaqueter l'APK.
  // Activé via `BUILD_TARGET=capacitor npm run build`.
  ...(process.env.BUILD_TARGET === "capacitor"
    ? { output: "export" as const, images: { unoptimized: true } }
    : {}),

  async headers() {
    return [
      {
        // Le service worker doit pouvoir contrôler toute l'origine.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default config;
