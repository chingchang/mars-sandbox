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
COPY --from=build /app /app
# the compiler and the smoke test run as this user, not root
USER node
ENV WORKSHOP_BIND=0.0.0.0 WORKSHOP_PORT=8787 WORKSHOP_STATIC=dist
EXPOSE 8787
CMD ["node", "workshop/server.mts"]
