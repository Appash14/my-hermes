# Hermes, assistant personnel auto-hébergé

Mon premier assistant IA personnel, avant Sirius. Un chat texte et vocal, accessible dans le navigateur (PWA installable) et en APK Android, qui tourne entièrement sur mon serveur. Le modèle se change depuis l'app : une seule clé OpenRouter donne accès à plusieurs centaines de modèles.

## Architecture

```
Navigateur / APK ──▶ Caddy (HTTPS automatique)
                       ├── /api, /ws ──▶ agent (Fastify)
                       └── le reste  ──▶ web (Next.js)

agent ──▶ Postgres, Redis
agent ──▶ OpenRouter (modèles), Deepgram (écoute), ElevenLabs (voix)
```

Mode vocal : le micro envoie le son à Deepgram, le texte part au modèle, et la réponse est envoyée phrase par phrase à ElevenLabs. Hermes commence donc à parler avant d'avoir fini sa réponse.

## Structure

| Chemin | Rôle |
|---|---|
| `apps/agent/` | Service Node : boucle agentique, outils, mémoire, voix |
| `apps/web/` | Next.js : interface, PWA, choix du modèle |
| `deploy/` | Préparation du serveur et schéma SQL |
| `docker-compose.yml` | La stack complète |
| `Caddyfile` | Reverse proxy et certificat TLS |

Ajouter un outil à l'agent : une entrée dans `apps/agent/src/agent/tools.ts`, rien d'autre à brancher.

## Lancer

```sh
cp .env.example .env    # clés OpenRouter, Deepgram, ElevenLabs, domaine
docker compose up -d --build
```

Prévoir un serveur avec 4 Go de RAM et 2 Go de swap pour le build Next.js.

## Statut

Projet terminé et remplacé par Sirius, mon assistant actuel. Le code reste un bon exemple d'agent avec outils et voix en streaming.
