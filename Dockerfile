# --- Stage 1: Build/prepare ---
FROM oven/bun:1.3.5-debian AS builder
WORKDIR /app

# Native build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx prisma generate

# --- Stage 2: Production runner ---
FROM oven/bun:1.3.5-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

RUN groupadd -r appuser && useradd -r -g appuser -s /bin/false appuser
USER appuser

EXPOSE 4000

CMD ["bun", "src/index.ts"]
