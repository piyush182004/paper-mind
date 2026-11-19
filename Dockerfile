# All-in-one image: website + Node API + Python ML service in one container.
# Made for single-container hosts (Hugging Face Spaces, Render, Railway, Fly.io). Port 8080.
# Needs DATABASE_URL (e.g. free Neon Postgres) so data survives restarts.
# For separate containers use docker-compose.yml (apps/api/Dockerfile + services/ml/Dockerfile).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY apps ./apps
RUN npm run build -w apps/web && npm run build -w apps/api

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund -w apps/api

FROM python:3.12-slim
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN useradd -m -u 1000 user
WORKDIR /home/user/app
COPY services/ml/requirements.txt services/ml/
RUN pip install -r services/ml/requirements.txt
COPY --chown=user services/ml/app services/ml/app
COPY --chown=user --from=deps /app ./
COPY --chown=user --from=build /app/apps/api/dist apps/api/dist
COPY --chown=user --from=build /app/apps/web/dist apps/web/dist
COPY --chown=user deploy/start.sh deploy/start.sh
RUN mkdir -p apps/api/data services/ml/data && chown -R user apps/api/data services/ml/data
USER user
# bake the embedding + reranking models into the image so cold starts never download them
RUN cd services/ml && python -c "from app.models import embedder, reranker; embedder(); reranker()"
ENV NODE_ENV=production PORT=8080 ENVIRONMENT=production ML_MODE=service ML_SERVICE_URL=http://127.0.0.1:8001
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "deploy/start.sh"]
