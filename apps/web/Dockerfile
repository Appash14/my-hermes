# Next.js en mode `standalone` : le serveur final n'embarque que les
# dépendances réellement utilisées au runtime.

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

# L'URL de l'agent est figée dans le bundle client au moment du build :
# les variables NEXT_PUBLIC_* n'existent plus au runtime.
ARG NEXT_PUBLIC_AGENT_URL
ENV NEXT_PUBLIC_AGENT_URL=$NEXT_PUBLIC_AGENT_URL

RUN npm run build

# ── Image finale ─────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `standalone` produit un server.js autonome ; `static` et `public`
# doivent être copiés à part, Next ne les inclut pas.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

USER node

EXPOSE 3000

CMD ["node", "server.js"]
