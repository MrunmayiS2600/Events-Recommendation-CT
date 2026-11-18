'use strict';

/**
 * store.js
 *
 * The training corpus. One JSON file on disk + an in-memory index built at
 * load time. Designed for low-write / read-heavy workloads (trainer uploads
 * once a day; client scans read on every request).
 *
 * Atomic writes via "write tmp + rename" so a crash mid-write can't corrupt
 * the corpus. Index is rebuilt on every mutation — fine up to a few thousand
 * entries; the retriever is decoupled so a real vector DB can replace this
 * later without touching callers.
 *
 * Schema (one entry):
 *   {
 *     id:              "uuid",
 *     appName:         "Acme Shop",
 *     packageName:     "com.acme.shop",
 *     fileName:        "acme-shop-1.4.2.apk",
 *     vertical:        "ecommerce",         // optional, used as retrieval filter
 *     signalsSummary:  "app: ...\npermissions: ...",
 *     signalsRaw:      { ...raw extractApkSignals output... },
 *     eventSheet:      [ {eventName, category, priority, ...} ],
 *     createdAt:       "2026-05-19T10:11:12.000Z",
 *     schemaVersion:   1,
 *   }
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createRetriever }    = require('./retriever');
const { summariseApkSignals } = require('./signalsSummary');

const SCHEMA_VERSION = 1;

class TrainingStore {
  constructor({ dataDir } = {}) {
    this.dataDir   = dataDir || path.join(__dirname, 'data');
    this.dataFile  = path.join(this.dataDir, 'corpus.json');
    this.entries   = [];
    this.retriever = createRetriever();
    this._loaded   = false;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────
  _load() {
    if (this._loaded) return;
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (fs.existsSync(this.dataFile)) {
      try {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.entries = parsed;
      } catch (err) {
        console.warn('[TrainingStore] corpus.json unreadable, starting empty:', err.message);
        this.entries = [];
      }
    }
    this._reindex();
    this._loaded = true;
    console.log(`[TrainingStore] loaded ${this.entries.length} entries from ${this.dataFile}`);
  }

  _persist() {
    const tmp = `${this.dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2), 'utf8');
    fs.renameSync(tmp, this.dataFile);
  }

  _reindex() {
    this.retriever.index(this.entries);
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  /**
   * Add a new corpus entry from extracted APK signals + a validated event sheet.
   * Returns the stored entry (without signalsRaw, which is bulky).
   */
  add({ signals, events, vertical, appName, fileName }) {
    this._load();

    if (!signals || typeof signals !== 'object') {
      throw new Error('add(): signals object is required');
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error('add(): events array is required and non-empty');
    }

    const entry = {
      id:             crypto.randomUUID(),
      appName:        appName || signals.appLabel || 'Unknown App',
      packageName:    signals.packageName || '',
      fileName:       fileName || signals.apkFileName || '',
      vertical:       (vertical || '').toLowerCase() || null,
      signalsSummary: summariseApkSignals(signals),
      signalsRaw:     signals,
      eventSheet:     events,
      createdAt:      new Date().toISOString(),
      schemaVersion:  SCHEMA_VERSION,
    };

    this.entries.push(entry);
    this._persist();
    this._reindex();

    console.log(
      `[TrainingStore] added "${entry.appName}" (${events.length} events, vertical=${entry.vertical || 'unknown'}). ` +
      `Corpus size: ${this.entries.length}`
    );
    return this._publicView(entry);
  }

  list() {
    this._load();
    return this.entries.map((e) => this._publicView(e));
  }

  get(id) {
    this._load();
    const entry = this.entries.find((e) => e.id === id);
    return entry ? { ...this._publicView(entry), eventSheet: entry.eventSheet } : null;
  }

  delete(id) {
    this._load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this._persist();
    this._reindex();
    return true;
  }

  stats() {
    this._load();
    const byVertical = {};
    for (const e of this.entries) {
      const v = e.vertical || 'unknown';
      byVertical[v] = (byVertical[v] || 0) + 1;
    }
    return {
      totalEntries: this.entries.length,
      byVertical,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  /**
   * Retrieve top-K most similar corpus entries for a live APK's signals.
   *
   * Options:
   *   - topK:           how many neighbours to return (default 3)
   *   - verticalFilter: prefer entries with this vertical; falls back to all
   *                     if fewer than topK pass the filter (so cold-start in a
   *                     vertical doesn't return nothing)
   *   - minScore:       drop neighbours below this normalised BM25 rank (0..1).
   *                     NOTE: this is a rank-normalised score, so the TOP doc
   *                     in any result set is always 1.0. It's useful for
   *                     dropping the 2nd/3rd-ranked when they trail far behind
   *                     the top, but it can't tell a strong absolute match
   *                     from a weak one — use `minCoverage` for that.
   *   - minCoverage:    drop neighbours where fewer than this fraction of the
   *                     unique query terms actually occur in the doc (0..1).
   *                     This is the meaningful "is this actually similar?"
   *                     threshold. With a sparse corpus, this is what stops
   *                     unrelated apps from being treated as neighbours.
   *
   * Returns: [{ id, appName, vertical, score, coverage, eventSheet }]
   */
  retrieve(signals, { topK = 3, verticalFilter = null, minScore = 0.4, minCoverage = 0.25 } = {}) {
    this._load();
    if (this.entries.length === 0) return [];

    const queryText = summariseApkSignals(signals);
    const scored = this.retriever.score(queryText);
    const byId = new Map(scored.map((s) => [s.id, s]));

    const annotated = this.entries.map((e) => {
      const m = byId.get(e.id) || { score: 0, coverage: 0 };
      return {
        id:         e.id,
        appName:    e.appName,
        vertical:   e.vertical,
        score:      m.score,
        coverage:   m.coverage,
        eventSheet: e.eventSheet,
      };
    });

    annotated.sort((a, b) => b.score - a.score);

    let pool = annotated;
    if (verticalFilter) {
      const filtered = annotated.filter((e) => e.vertical === verticalFilter.toLowerCase());
      // Only honour the filter if it yields enough matches; otherwise fall
      // back to the full pool so a brand-new vertical isn't stuck empty.
      if (filtered.length >= Math.min(topK, 2)) pool = filtered;
    }

    return pool
      .filter((e) => e.score >= minScore && e.coverage >= minCoverage)
      .slice(0, topK);
  }

  _publicView(entry) {
    return {
      id:            entry.id,
      appName:       entry.appName,
      packageName:   entry.packageName,
      fileName:      entry.fileName,
      vertical:      entry.vertical,
      eventCount:    entry.eventSheet.length,
      createdAt:     entry.createdAt,
      schemaVersion: entry.schemaVersion,
    };
  }
}

// Single shared instance — the corpus is process-wide state.
const sharedStore = new TrainingStore();

module.exports = {
  TrainingStore,
  store: sharedStore,
};
