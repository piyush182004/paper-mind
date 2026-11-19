"""Topic clustering for papers (BERTopic-style pipeline, implemented directly):

  embeddings --UMAP(5d)--> HDBSCAN | K-Means  --> topics
             --UMAP(2d)--> map coordinates
  docs per topic --class-based TF-IDF--> keywords & names
  topic centroids --agglomerative (cosine, average)--> parent themes (hierarchy)

Outliers: HDBSCAN noise (label -1) plus a per-paper outlier score
(1 - membership probability for HDBSCAN; distance-to-centroid percentile for K-Means).
"""
from __future__ import annotations

import warnings

import numpy as np
from sklearn.cluster import HDBSCAN, AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.metrics import silhouette_score

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

EXTRA_STOP = {
    "paper", "propose", "proposed", "approach", "method", "methods", "results", "using", "based", "new",
    "show", "work", "study", "use", "used", "model", "models", "data", "different", "present", "paper",
    "also", "however", "existing", "problem", "performance", "task", "tasks", "et", "al", "non",
}


def _l2(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return x / n


def _reduce(x: np.ndarray, dims: int, seed: int) -> np.ndarray:
    n = len(x)
    if n <= dims + 1:
        return PCA(n_components=min(dims, max(1, n - 1)), random_state=seed).fit_transform(x) if n > 1 else np.zeros((n, dims))
    if n < 12:  # UMAP is unstable on tiny inputs: PCA is the honest choice there
        out = PCA(n_components=dims, random_state=seed).fit_transform(x)
        return out
    import umap  # imported lazily: numba JIT warm-up is slow

    return umap.UMAP(
        n_components=dims, n_neighbors=min(15, n - 1), min_dist=0.0 if dims > 2 else 0.1,
        metric="cosine", random_state=seed, init="spectral" if n > 30 else "random",
    ).fit_transform(x)


def _ctfidf(docs: list[str], labels: np.ndarray, top_n: int = 8) -> dict[int, list[tuple[str, float]]]:
    """Class-based TF-IDF (Grootendorst 2022): treat each cluster as one document."""
    uniq = sorted(set(int(l) for l in labels if l >= 0))
    if not uniq:
        return {}
    joined = [" ".join(d for d, l in zip(docs, labels) if l == c) for c in uniq]
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

    vec = CountVectorizer(stop_words=list(ENGLISH_STOP_WORDS | EXTRA_STOP), ngram_range=(1, 2), min_df=1,
                          token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z0-9\-]{2,}\b")
    try:
        tf = vec.fit_transform(joined).toarray().astype(float)
    except ValueError:  # empty vocabulary
        return {c: [] for c in uniq}
    words = vec.get_feature_names_out()
    tf_norm = tf / np.maximum(tf.sum(axis=1, keepdims=True), 1)
    avg_words = tf.sum() / len(uniq)
    idf = np.log(1 + avg_words / np.maximum(tf.sum(axis=0), 1))
    scores = tf_norm * idf
    out: dict[int, list[tuple[str, float]]] = {}
    for i, c in enumerate(uniq):
        order = np.argsort(-scores[i])
        picked: list[tuple[str, float]] = []
        for j in order:
            w = words[j]
            if scores[i, j] <= 0:
                break
            # skip a unigram already covered by a chosen bigram (and vice versa)
            if any(w in p or p in w for p, _ in picked):
                continue
            picked.append((w, float(scores[i, j])))
            if len(picked) >= top_n:
                break
        out[c] = picked
    return out


def cluster(embeddings: list[list[float]], docs: list[str], algorithm: str = "hdbscan",
            min_cluster_size: int | None = None, k: int | None = None, seed: int = 42) -> dict:
    if not embeddings:
        return {"labels": [], "probabilities": [], "outlier_scores": [], "xy": [], "clusters": [], "parents": [],
                "silhouette": None, "n_noise": 0, "algorithm": algorithm, "params": {}}
    x = _l2(np.asarray(embeddings, dtype=np.float32))
    n = len(x)

    reduced = _reduce(x, 5, seed) if n > 6 else x
    xy = _reduce(x, 2, seed)
    params: dict = {"n": n}

    if n < 4:
        labels = np.zeros(n, dtype=int)
        probs = np.ones(n)
        algorithm = "single"
    elif algorithm == "kmeans":
        if k is None:  # choose k by silhouette on the reduced space
            best = (-1.0, 2)
            for kk in range(2, min(12, n - 1) + 1):
                lab = KMeans(n_clusters=kk, n_init=10, random_state=seed).fit_predict(reduced)
                s = silhouette_score(reduced, lab) if len(set(lab)) > 1 else -1
                if s > best[0]:
                    best = (s, kk)
            k = best[1]
        km = KMeans(n_clusters=k, n_init=10, random_state=seed).fit(reduced)
        labels = km.labels_
        d = np.linalg.norm(reduced - km.cluster_centers_[labels], axis=1)
        probs = 1 - (np.argsort(np.argsort(d)) / max(1, n - 1))  # rank-based: farthest = least typical
        params["k"] = int(k)
    else:
        mcs = min_cluster_size or max(3, min(25, round(n * 0.04)))
        hd = HDBSCAN(min_cluster_size=mcs, min_samples=max(1, mcs // 2), metric="euclidean",
                     cluster_selection_method="eom", allow_single_cluster=n < 20)
        labels = hd.fit_predict(reduced)
        probs = hd.probabilities_
        params["min_cluster_size"] = int(mcs)
        algorithm = "hdbscan"

    labels = np.asarray(labels, dtype=int)
    outlier = np.clip(1 - np.asarray(probs, dtype=float), 0, 1)
    valid = labels >= 0
    sil = None
    if valid.sum() > 2 and len(set(labels[valid])) > 1:
        sil = float(silhouette_score(reduced[valid], labels[valid]))

    keywords = _ctfidf(docs, labels)
    clusters = []
    centroids = {}
    for c in sorted(set(int(l) for l in labels if l >= 0)):
        members = x[labels == c]
        cen = members.mean(axis=0)
        cen_n = cen / (np.linalg.norm(cen) or 1)
        centroids[c] = cen_n
        coherence = float(np.mean(members @ cen_n))  # mean cosine to centroid in the original space
        kw = keywords.get(c, [])
        name = " · ".join(w for w, _ in kw[:3]) or f"Topic {c}"
        clusters.append({"label": c, "name": name, "keywords": [{"term": w, "score": round(s, 4)} for w, s in kw],
                         "size": int((labels == c).sum()), "coherence": round(coherence, 4), "parent": None})

    parents = []
    if len(centroids) >= 4:  # hierarchy only makes sense with enough topics
        ids = list(centroids)
        cm = np.stack([centroids[i] for i in ids])
        agg = AgglomerativeClustering(n_clusters=None, metric="cosine", linkage="average", distance_threshold=0.35)
        plabels = agg.fit_predict(cm)
        if 1 < len(set(plabels)) < len(ids):
            doc_parent = np.array([plabels[ids.index(l)] if l >= 0 else -1 for l in labels])
            pkw = _ctfidf(docs, doc_parent, top_n=6)
            for p in sorted(set(int(v) for v in plabels)):
                children = [ids[i] for i in range(len(ids)) if plabels[i] == p]
                if len(children) < 2:
                    continue
                for cl in clusters:
                    if cl["label"] in children:
                        cl["parent"] = int(p)
                kw = pkw.get(p, [])
                parents.append({"label": int(p), "name": " · ".join(w for w, _ in kw[:3]) or f"Theme {p}",
                                "keywords": [{"term": w, "score": round(s, 4)} for w, s in kw],
                                "children": children, "size": int(sum((labels == c).sum() for c in children))})

    return {
        "algorithm": algorithm,
        "params": params,
        "labels": labels.tolist(),
        "probabilities": [round(float(p), 4) for p in probs],
        "outlier_scores": [round(float(o), 4) for o in outlier],
        "xy": [[round(float(a), 4), round(float(b), 4)] for a, b in (xy if xy.shape[1] >= 2 else np.c_[xy, np.zeros(n)])],
        "clusters": clusters,
        "parents": parents,
        "silhouette": None if sil is None else round(sil, 4),
        "n_noise": int((labels < 0).sum()),
    }
