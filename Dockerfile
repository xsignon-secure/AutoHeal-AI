# Self-hosted AutoHeal dashboard.
#   docker build -t autoheal-dashboard .
#   docker run -p 8080:8080 -v autoheal-data:/data -e AUTOHEAL_DASHBOARD_SECRET=... -e AUTOHEAL_DASHBOARD_VIEW_TOKEN=... autoheal-dashboard
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 AUTOHEAL_DB=/data/autoheal.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.js", "dashboard"]
