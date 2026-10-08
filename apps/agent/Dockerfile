# Build multi-étapes : l'image finale ne contient ni les sources TypeScript
# ni les dépendances de build. Compte ~180 Mo au lieu de ~450.

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Image finale ─────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Ne pas tourner en root : si le processus est compromis, il n'a pas
# les droits d'écriture sur le reste du conteneur.
USER node

EXPOSE 4000

CMD ["node", "dist/index.js"]
