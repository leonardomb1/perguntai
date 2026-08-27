# --- build stage ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# --- runtime stage ---
FROM node:22-slim
# ca-certificates: node:slim ships none, and the microsandbox SDK's native
# (Rust) OCI pull ABORTS THE WHOLE PROCESS without system CAs. Needed for the
# code-execution capability; harmless otherwise.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    # uploads go up to 8 MB (spreadsheets); adapter-node defaults to 512K
    BODY_SIZE_LIMIT=20M \
    DATA_DIR=/app/data \
    SCHEMA_PATH=/app/data/schema.json

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
# schema sync runs in-container: docker compose exec app node scripts/sync-schema.js
COPY --from=build /app/scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app/data \
	# code-execution (BETA): pre-own the microsandbox cache mountpoint so a
	# named volume initializes writable for the node user
	&& mkdir -p /home/node/.microsandbox && chown node:node /home/node/.microsandbox
USER node
EXPOSE 3000
CMD ["node", "build"]
