# syntax=docker/dockerfile:1
# ---------- build (dependências completas — também usado pelo serviço "seed") ----------
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
# Mesma versão do npm que gerou o package-lock.json (o npm 10 da imagem lê o lock de outro jeito).
# Rede instável: mais tentativas, menos conexões simultâneas e cache persistente entre builds.
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 6 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set maxsockets 6 && \
    npm install -g npm@12.1.0 && \
    npm ci --prefer-offline --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------- dependências de produção ----------
FROM build AS prod-deps
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl tini wget
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Aplica migrações pendentes e sobe a API.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
