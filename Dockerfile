# Penny by Propono. TypeScript runs directly on Node 22.18+ (type stripping), so there is no build step.
FROM node:22.22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    PENNY_RUNLOG=/data/runs.jsonl \
    PENNY_LEADS=/data/leads.jsonl \
    PENNY_TRUST_PROXY=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# The run log lives on a mounted volume in Azure; locally it falls back to this directory.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "src/server/index.ts"]
