# Node API + built React UI in one image (the ML service has its own image: services/ml/Dockerfile)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps ./apps
RUN npm run build -w apps/web && npm run build -w apps/api

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund -w apps/api
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN adduser -D -u 10001 app && mkdir -p apps/api/data && chown -R app /app/apps/api/data
USER app
WORKDIR /app/apps/api
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/index.js"]
