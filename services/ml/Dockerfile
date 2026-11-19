FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 ENVIRONMENT=production
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app ./app
RUN useradd -m -u 10001 app && mkdir -p data && chown -R app /app
USER app
# bake the models into the image so cold starts never download them
RUN python -c "from app.models import embedder, reranker; embedder(); reranker()"
EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
