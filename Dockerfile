# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20 AS runner

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build ./build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "node_modules/.bin/remix-serve", "./build/server/index.js"]
