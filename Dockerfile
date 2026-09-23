# PrivaPace read-only operator. Holds no keys and sends no transactions.
#   docker build -t privapace-operator .
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile && rm -rf /root/.cache /root/.local/share/pnpm/store
COPY tsconfig.json ./
COPY src/ src/
COPY deployments/ deployments/
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 \
    SABERENT_MANIFEST=/app/deployments/testnet.operator.json
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO- http://127.0.0.1:8788/health >/dev/null || exit 1
CMD ["node_modules/.bin/tsx", "src/main.ts"]
