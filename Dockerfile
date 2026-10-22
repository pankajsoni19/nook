FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY shared ./shared
RUN bun run build

FROM dependencies AS verify
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY shared ./shared
COPY server ./server
COPY tests ./tests
COPY bunfig.toml ./
RUN bun run typecheck && bun test && bun run build

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
# D545: ONNX Runtime Web ships builds for browsers (WebGPU, WebGL, JSPI, asyncify) and source maps;
# the server loads only its Node entry and the single-threaded SIMD WebAssembly (about 14 MB of 140).
RUN bun install --frozen-lockfile --production \
  && find node_modules/onnxruntime-web/dist -type f ! -name ort.node.min.mjs ! -name ort-wasm-simd-threaded.mjs ! -name ort-wasm-simd-threaded.wasm -delete \
  && rm -rf node_modules/onnxruntime-web/lib

# D545: the local embedding model, fetched from its pinned commit and checked (size and sha256) at build
# time, so a running Nook never downloads it. Root-owned in the image: the app can read it, not change it.
# D548: LOCAL_EMBEDDINGS_MODEL=skip builds without it (135 MB less); the Local kind is then offered only
# when LOCAL_EMBEDDINGS_DIR holds the verified files.
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS local-model
ARG LOCAL_EMBEDDINGS_MODEL=include
WORKDIR /app
COPY shared/localEmbedding.ts ./shared/localEmbedding.ts
COPY scripts/fetchLocalModel.ts ./scripts/fetchLocalModel.ts
RUN case "$LOCAL_EMBEDDINGS_MODEL" in \
      include) bun scripts/fetchLocalModel.ts /app/models/multilingual-e5-small ;; \
      skip) mkdir -p /app/models ;; \
      *) echo "LOCAL_EMBEDDINGS_MODEL must be include or skip" >&2; exit 1 ;; \
    esac

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS production
WORKDIR /app
ARG APP_VERSION=0.43.0
ARG GIT_SHA=development
ENV NODE_ENV=production \
    PORT=2026 \
    DATA_DIR=/data \
    APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA
COPY --chown=bun:bun --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=bun:bun --from=production-dependencies /app/package.json ./package.json
COPY --chown=bun:bun --from=build /app/dist ./dist
COPY --chown=bun:bun server ./server
COPY --chown=bun:bun shared ./shared
COPY --from=local-model /app/models ./models
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 2026
HEALTHCHECK --interval=15s --timeout=3s --start-period=8s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:2026/api/health || exit 1
CMD ["bun", "server/index.ts"]
