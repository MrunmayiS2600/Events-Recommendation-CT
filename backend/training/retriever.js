'use strict';

/**
 * retriever.js
 *
 * BM25 retriever over the training corpus. The corpus stores raw signal
 * summaries; the retriever holds an in-memory inverted index built from those
 * summaries plus the per-document length statistics BM25 needs.
 *
 * Why BM25 (and not sentence embeddings) for the MVP:
 *   - The signal text is a list of permissions, SDK names, screen names, UI
 *     strings — i.e. keyword-heavy, not natural language. BM25 is strong on
 *     keyword-heavy text and trivial to ship (zero deps, no model download).
 *   - Pluggable interface below means swapping in MiniLM or OpenAI embeddings
 *     later only requires writing a new `Retriever` class with the same
 *     `index(entries)` / `score(query, entry)` shape; the store doesn't change.
 *
 * Tunables exposed via constructor: k1=1.5, b=0.75 are the standard defaults.
 */

const { tokenise } = require('./signalsSummary');

const DEFAULT_K1 = 1.5;
const DEFAULT_B  = 0.75;

class Bm25Retriever {
  constructor({ k1 = DEFAULT_K1, b = DEFAULT_B } = {}) {
    this.k1 = k1;
    this.b  = b;
    this.docs        = [];   // [{ id, tokens, length }]
    this.docFreq     = new Map();   // term -> # docs containing it
    this.avgDocLen   = 0;
    this.totalDocs   = 0;
  }

  /**
   * Build/replace the index from the full corpus entry list.
   * Each entry must have { id, signalsSummary }.
   */
  index(entries) {
    this.docs = [];
    this.docFreq = new Map();
    let totalLen = 0;

    for (const entry of entries) {
      const tokens = tokenise(entry.signalsSummary || '');
      this.docs.push({ id: entry.id, tokens, length: tokens.length });
      totalLen += tokens.length;

      const seen = new Set();
      for (const t of tokens) {
        if (seen.has(t)) continue;
        seen.add(t);
        this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1);
      }
    }

    this.totalDocs = this.docs.length;
    this.avgDocLen = this.totalDocs > 0 ? totalLen / this.totalDocs : 0;
  }

  /**
   * Score every indexed document against the query text.
   * Returns an array of { id, score, coverage } sorted descending by score.
   *
   * `score` is normalised to [0, 1] by dividing each doc's raw BM25 by the top
   * score in the result set. This makes ranking stable across corpora of
   * different sizes, but — critically — the top doc is ALWAYS 1.0, so `score`
   * alone cannot tell a strong match from a weak one. Use `coverage`.
   *
   * `coverage` is the fraction of unique query terms that actually appear in
   * the candidate document, in [0, 1]. It is NOT normalised by result-set
   * rank — a doc with 5% term overlap stays at 0.05 even if it's the best
   * available. That's what makes it a meaningful absolute filter for thin /
   * irrelevant corpus matches.
   */
  score(queryText) {
    if (this.totalDocs === 0) return [];

    const queryTokens = tokenise(queryText);
    if (queryTokens.length === 0) return [];

    const queryTf = new Map();
    for (const t of queryTokens) queryTf.set(t, (queryTf.get(t) || 0) + 1);
    const uniqueQueryTerms = queryTf.size;

    const raw = [];
    for (const doc of this.docs) {
      let s = 0;
      let matchedTerms = 0;
      const docTf = new Map();
      for (const t of doc.tokens) docTf.set(t, (docTf.get(t) || 0) + 1);

      for (const [term, qf] of queryTf) {
        const tf = docTf.get(term) || 0;
        if (tf === 0) continue;
        matchedTerms++;
        const df  = this.docFreq.get(term) || 0;
        const idf = Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5));
        const tfNorm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (doc.length / (this.avgDocLen || 1))));
        s += idf * tfNorm * qf;
      }
      raw.push({
        id: doc.id,
        raw: s,
        coverage: uniqueQueryTerms > 0 ? matchedTerms / uniqueQueryTerms : 0,
      });
    }

    raw.sort((a, b) => b.raw - a.raw);
    const top = raw[0]?.raw || 0;
    if (top <= 0) return raw.map((r) => ({ id: r.id, score: 0, coverage: r.coverage }));

    return raw.map((r) => ({ id: r.id, score: r.raw / top, coverage: r.coverage }));
  }
}

/**
 * Factory — picks the retriever backend by env var.
 * Today only BM25; later branches will lazy-require MiniLM/OpenAI implementations.
 */
function createRetriever() {
  const provider = (process.env.RETRIEVAL_PROVIDER || 'bm25').toLowerCase();
  if (provider === 'bm25') return new Bm25Retriever();
  throw new Error(`Unknown RETRIEVAL_PROVIDER "${provider}". Supported: bm25`);
}

module.exports = {
  Bm25Retriever,
  createRetriever,
};
