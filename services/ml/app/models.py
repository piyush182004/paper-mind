"""Local ONNX models via fastembed (no torch, no API keys): BGE embeddings + cross-encoder reranker."""
from __future__ import annotations

import logging
import os
import threading

import numpy as np

from .config import get_settings

log = logging.getLogger(__name__)
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# BGE retrieval models expect this instruction on *queries* (not on passages).
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

_lock = threading.Lock()
_embedder = None
_reranker = None


def embedder():
    global _embedder
    with _lock:
        if _embedder is None:
            from fastembed import TextEmbedding

            s = get_settings()
            os.makedirs(s.models_dir, exist_ok=True)
            _embedder = TextEmbedding(model_name=s.embed_model, cache_dir=s.models_dir)
            log.info("loaded embedding model %s", s.embed_model)
    return _embedder


def reranker():
    global _reranker
    with _lock:
        if _reranker is None:
            from fastembed.rerank.cross_encoder import TextCrossEncoder

            s = get_settings()
            _reranker = TextCrossEncoder(model_name=s.rerank_model, cache_dir=s.models_dir)
            log.info("loaded reranker %s", s.rerank_model)
    return _reranker


def embed(texts: list[str], is_query: bool = False) -> list[list[float]]:
    if not texts:
        return []
    s = get_settings()
    inputs = [(BGE_QUERY_PREFIX + t if is_query else t)[:4000] for t in texts]
    vecs = np.vstack(list(embedder().embed(inputs, batch_size=s.embed_batch)))
    vecs = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
    return vecs.astype(np.float32).round(6).tolist()


def rerank(query: str, docs: list[str]) -> list[float]:
    if not docs:
        return []
    scores = list(reranker().rerank(query, [d[:2000] for d in docs]))
    # logits -> (0,1) so callers can mix scores across queries
    return [round(float(1 / (1 + np.exp(-s))), 5) for s in scores]
