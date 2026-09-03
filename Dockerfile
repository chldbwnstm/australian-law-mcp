# australian-law-mcp — container image

# --- Build Stage ---
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts --omit=optional

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

RUN npm run build
RUN npm prune --omit=dev --omit=optional --ignore-scripts

# --- Runtime Stage ---
FROM node:22-alpine

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
# A container is explicitly a remote deployment unit. Bind externally, but
# fail startup unless the operator supplies MCP_AUTH_TOKEN (or deliberately
# opts into MCP_ALLOW_UNAUTHENTICATED_REMOTE at runtime).
ENV MCP_HTTP_HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "build/index.js", "--mode", "sse", "--port", "3000"]
