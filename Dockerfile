# syntax=docker/dockerfile:1

########################################
# Stage 1 — install production deps
########################################
FROM node:22-alpine AS deps
WORKDIR /app

# Copy only manifests first so this layer is cached unless deps change
COPY package.json package-lock.json ./
# Deterministic, production-only install
RUN npm ci --omit=dev && npm cache clean --force

########################################
# Stage 2 — minimal, non-root runtime
# Chainguard node: distroless-style (no shell/pkg mgr), nonroot uid 65532,
# and maintained to carry ~zero known CVEs so the Trivy gate stays honest.
########################################
FROM cgr.dev/chainguard/node:latest AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

# App code + vetted node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY app.js ./

EXPOSE 8080
# Run as the built-in nonroot user (explicit, though it's already the default).
USER 65532
# Chainguard node image's entrypoint is already "node"
CMD ["app.js"]
