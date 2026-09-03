# syntax=docker/dockerfile:1.7

# One pinned multi-architecture OCI index supports linux/amd64 and linux/arm64
# without allowing a mutable base tag to change the artifact underneath us.
FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS build
ARG VERSION
ARG SOURCE_DATE_EPOCH=0
WORKDIR /build

COPY package.json package-lock.json .npmrc ./
RUN npm ci --engine-strict --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts/clean-dist.mjs ./scripts/clean-dist.mjs
COPY deploy/container-healthcheck.mjs ./deploy/container-healthcheck.mjs
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && node -e 'const actual=require("./package.json").version; if (!process.argv[1] || process.argv[1] !== actual) process.exit(1)' "${VERSION}" \
    && mkdir -p /runtime-root/app /runtime-root/home/servicenow-mcp/.servicenow-mcp \
    && cp package.json /runtime-root/app/package.json \
    && cp -a node_modules dist /runtime-root/app/ \
    && cp deploy/container-healthcheck.mjs /runtime-root/app/container-healthcheck.mjs \
    && chown -R 10001:10001 /runtime-root/app /runtime-root/home/servicenow-mcp \
    && chmod 0700 /runtime-root/home/servicenow-mcp /runtime-root/home/servicenow-mcp/.servicenow-mcp \
    && find /runtime-root -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50 AS runtime

ARG VERSION
ARG REVISION=local
ARG CREATED=1970-01-01T00:00:00.000Z

LABEL org.opencontainers.image.title="ServiceNow MCP" \
      org.opencontainers.image.description="HTTP-only single-owner ServiceNow MCP service" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/onlyflowstech/servicenow-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs22-debian13:nonroot" \
      org.opencontainers.image.base.digest="sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50"

ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000 \
    HOME=/home/servicenow-mcp

WORKDIR /app
COPY --from=build /runtime-root/ /

USER 10001:10001
EXPOSE 3000/tcp
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/container-healthcheck.mjs"]
# dist/index.js is the stdio entrypoint and has no meaning in a container.
# The image serves the dormant HTTP transport, which is what this runs.
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/http-entrypoint.js"]
