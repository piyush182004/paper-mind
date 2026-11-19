"""Offline tests for the ML service (no model downloads: embeddings are synthetic)."""
from __future__ import annotations

import pymupdf as fitz
import numpy as np
from fastapi.testclient import TestClient

from app import clustering, pdf
from app.config import get_settings


def make_pdf() -> bytes:
    doc = fitz.open()
    body = ("Graph neural networks learn node representations by aggregating information from neighbours. "
            "We evaluate on three citation benchmarks and report accuracy for every split of the data. ") * 2
    for n in range(1, 4):
        page = doc.new_page()
        page.insert_text((72, 40), "Preprint under review", fontsize=8)          # running header
        if n == 1:
            page.insert_text((72, 90), "1 Introduction", fontsize=16)
        if n == 2:
            page.insert_text((72, 90), "2 Experiments", fontsize=16)
        page.insert_textbox(fitz.Rect(72, 110, 520, 300), body, fontsize=10)
        if n == 2:
            page.insert_text((72, 330), "Table 1: Accuracy on Cora and PubMed.", fontsize=9)
            page.insert_text((72, 360), "L = sum_i (y_i - f(x_i))^2 + λ||θ||", fontsize=10)
        if n == 3:
            page.insert_text((72, 330), "References", fontsize=16)
            page.insert_textbox(fitz.Rect(72, 350, 520, 500), "[1] Kipf, T. Semi-supervised classification. ICLR.", fontsize=9)
        page.insert_text((300, 800), str(n), fontsize=8)                          # page number
    return doc.tobytes()


def test_parse_pdf_structure():
    out = pdf.parse_pdf(make_pdf())
    blocks = out["blocks"]
    assert out["pages"] == 3
    kinds = {b["kind"] for b in blocks}
    assert {"heading", "text", "table", "equation"} <= kinds
    headings = [b["text"] for b in blocks if b["kind"] == "heading"]
    assert "1 Introduction" in headings and "2 Experiments" in headings
    assert not any("Preprint under review" in b["text"] for b in blocks)        # header removed
    assert not any("Kipf" in b["text"] for b in blocks)                          # references skipped
    exp = [b for b in blocks if b["kind"] == "text" and b["page"] == 2]
    assert exp and exp[0]["section"] == "Experiments"


def blobs(seed=0):
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(3, 64))
    x, docs = [], []
    vocab = [["graph", "neural", "node", "message passing"], ["diffusion", "image", "denoising", "score"],
             ["protein", "folding", "molecule", "structure"]]
    for c in range(3):
        for _ in range(25):
            x.append(centers[c] + rng.normal(scale=0.15, size=64))
            docs.append(" ".join(rng.choice(vocab[c], size=6)) + " learning study")
    return np.array(x).tolist(), docs


def test_hdbscan_finds_topics_with_keywords():
    x, docs = blobs()
    out = clustering.cluster(x, docs, "hdbscan")
    assert len(out["clusters"]) == 3, out["clusters"]
    assert out["silhouette"] and out["silhouette"] > 0.5
    names = " ".join(c["name"] for c in out["clusters"])
    assert "graph" in names or "neural" in names
    assert len(out["xy"]) == 75 and all(0 <= o <= 1 for o in out["outlier_scores"])


def test_kmeans_picks_k_by_silhouette():
    x, docs = blobs(1)
    out = clustering.cluster(x, docs, "kmeans")
    assert out["params"]["k"] == 3 and out["n_noise"] == 0


def test_tiny_inputs_do_not_crash():
    assert clustering.cluster([[1.0, 0.0]], ["a"], "hdbscan")["labels"] == [0]
    assert clustering.cluster([], [], "hdbscan")["labels"] == []


def test_api_requires_token_when_configured(monkeypatch):
    from pydantic import SecretStr

    from app import main

    monkeypatch.setattr(main.settings, "ml_service_token", SecretStr("s3cret"))
    c = TestClient(main.app)
    assert c.get("/health").status_code == 200
    assert c.post("/cluster", json={"embeddings": [], "docs": []}).status_code == 401
    r = c.post("/cluster", json={"embeddings": [], "docs": []}, headers={"X-Internal-Token": "s3cret"})
    assert r.status_code == 200
    assert c.post("/parse-pdf", content=b"hello", headers={"X-Internal-Token": "s3cret"}).status_code == 415
    get_settings.cache_clear()
