"""PaperMind ML service: an internal microservice called only by the Node API.

Endpoints: /health, /embed, /rerank, /parse-pdf, /cluster.
Auth: shared secret in X-Internal-Token (required when ML_SERVICE_TOKEN is set).
CPU-bound work runs in a thread pool so the event loop stays responsive.
"""
from __future__ import annotations

import hmac
import logging
import time
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import clustering, models, pdf
from .config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("papermind.ml")
settings = get_settings()

app = FastAPI(title="PaperMind ML service", version="1.0.0", docs_url="/docs")


def require_token(x_internal_token: Annotated[str | None, Header()] = None) -> None:
    expected = settings.ml_service_token.get_secret_value() if settings.ml_service_token else None
    if expected is None:
        if settings.environment == "production":
            raise HTTPException(503, "ML_SERVICE_TOKEN must be set in production")
        return
    if not x_internal_token or not hmac.compare_digest(x_internal_token, expected):
        raise HTTPException(401, "invalid internal token")


Auth = Depends(require_token)


class EmbedIn(BaseModel):
    texts: list[str] = Field(..., max_length=512)
    is_query: bool = False


class RerankIn(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    documents: list[str] = Field(..., max_length=200)


class ClusterIn(BaseModel):
    embeddings: list[list[float]] = Field(..., max_length=20000)
    docs: list[str]
    algorithm: Literal["hdbscan", "kmeans"] = "hdbscan"
    min_cluster_size: int | None = Field(default=None, ge=2, le=500)
    k: int | None = Field(default=None, ge=2, le=100)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "embed_model": settings.embed_model, "rerank_model": settings.rerank_model}


@app.post("/embed", dependencies=[Auth])
async def embed(body: EmbedIn) -> dict:
    t0 = time.perf_counter()
    vecs = await run_in_threadpool(models.embed, body.texts, body.is_query)
    return {"embeddings": vecs, "dim": len(vecs[0]) if vecs else 0, "ms": round((time.perf_counter() - t0) * 1000)}


@app.post("/rerank", dependencies=[Auth])
async def rerank(body: RerankIn) -> dict:
    return {"scores": await run_in_threadpool(models.rerank, body.query, body.documents)}


@app.post("/parse-pdf", dependencies=[Auth])
async def parse_pdf(request: Request) -> dict:
    data = await request.body()
    if not data:
        raise HTTPException(400, "empty body; send the PDF bytes as application/pdf")
    if len(data) > settings.max_pdf_mb * 1024 * 1024:
        raise HTTPException(413, f"PDF larger than {settings.max_pdf_mb} MB")
    if not data.startswith(b"%PDF"):
        raise HTTPException(415, "not a PDF file")
    try:
        return await run_in_threadpool(pdf.parse_pdf, data, settings.max_pdf_pages,
                                       settings.pdf_table_pages, settings.pdf_table_budget_s)
    except Exception as exc:  # corrupt / encrypted PDFs
        log.warning("pdf parse failed: %s", exc.__class__.__name__)
        raise HTTPException(422, f"could not parse PDF ({exc.__class__.__name__})") from exc


@app.post("/cluster", dependencies=[Auth])
async def cluster(body: ClusterIn) -> dict:
    if len(body.docs) != len(body.embeddings):
        raise HTTPException(422, "docs and embeddings must have the same length")
    t0 = time.perf_counter()
    out = await run_in_threadpool(clustering.cluster, body.embeddings, body.docs, body.algorithm,
                                  body.min_cluster_size, body.k)
    out["ms"] = round((time.perf_counter() - t0) * 1000)
    return out
