# Build stage — install dev deps and compile TypeScript
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage — only production deps and compiled output
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# wget: healthcheck against /health.
# wireguard-tools + wireguard-go + iproute2: userspace WireGuard tunnel (wg0).
RUN sed -i 's/^#\s*\(.*community\)/\1/' /etc/apk/repositories \
 && apk update \
 && apk add --no-cache wget wireguard-tools wireguard-go iproute2

COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

# Entrypoint brings up WireGuard (if WG0_CONF is set) before starting the app.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
