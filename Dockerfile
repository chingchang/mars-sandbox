# Mars Sandbox in production (S1): one container that serves the packed client
# (dist/) and the workshop server. The key and the access code come from the
# host's environment at run time; nothing secret is baked into the image.
FROM node:22-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# behaviors/*.ts -> build/*.wasm (the samples bundled into the page), then dist/
RUN ./build.sh && node pack.mjs

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
# the server needs only the SDK and the AssemblyScript compiler at run time
RUN npm ci --omit=dev && npm cache clean --force
# only what the server reads at run time: the page, the server, the runtime the smoke test
# runs, the prompt's shared files, the fact index, and the entry point (no tests, no transcripts,
# no dev dependencies: the build stage's node_modules stay there)
COPY --from=build /app/dist ./dist
COPY --from=build /app/workshop ./workshop
COPY --from=build /app/runtime ./runtime
COPY --from=build /app/behaviors ./behaviors
COPY --from=build /app/test/smoke.mjs ./test/smoke.mjs
COPY --from=build /app/facts/index.json ./facts/index.json
COPY --from=build /app/docs/HOST_API.md ./docs/HOST_API.md
COPY --from=build /app/CLAUDE.md ./CLAUDE.md
COPY --from=build /app/scripts/container_start.sh ./scripts/container_start.sh
ENV WORKSHOP_BIND=0.0.0.0 WORKSHOP_PORT=8787 WORKSHOP_STATIC=dist
EXPOSE 8787
# the entry point hands a mounted state volume to `node` and runs the server as that user: the
# compiler and the smoke test never run as root
ENTRYPOINT ["/app/scripts/container_start.sh"]
CMD ["node", "workshop/server.mts"]
