/**
 * TrainingAdmin.jsx — corpus management UI for organisation members.
 *
 * Modern Techie 2.0 styling: glass cards on aurora backdrop, gradient hero,
 * pulsing live status, stat strip, toast notifications, keyboard shortcuts.
 *
 * Functional surface (unchanged):
 *  - passcode gate cached in localStorage
 *  - upload (apk + sheet) via POST /api/train
 *  - list / stats / delete via /api/training*
 *  - CSV template download
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL ? `${process.env.REACT_APP_API_URL}/api` : '/api';

const VERTICALS = [
  'social', 'content', 'messaging', 'ecommerce', 'food', 'fintech',
  'fitness', 'edu', 'travel', 'rideshare', 'gaming', 'productivity',
  'dating', 'health', 'utility',
];

const CSV_TEMPLATE =
  'event_name,category,priority,trigger_description,properties,reason\n' +
  'Product Viewed,Retention,must-have,User opens a product detail page,product_id|price|category,Funnel signal\n' +
  'Added to Cart,Activation,must-have,User taps Add to Cart on a product,product_id|quantity|price,Top-of-funnel intent\n' +
  'Checkout Started,Revenue,must-have,User begins the checkout flow,cart_total|item_count,Pre-purchase intent\n' +
  'Charged,Revenue,must-have,Payment successfully completed,order_id|amount|currency|payment_method,Revenue event\n' +
  '"Mid-cart Abandon",Retention,recommended,"User leaves with items in cart, no checkout started",cart_total|hours_idle,Recovery hook\n';

// ─── tiny event bus for toasts (in-component-tree) ───────────────────────────
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, ...t }]);
    const ttl = t.ttl ?? 5000;
    if (ttl > 0) setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), ttl);
  }, []);
  const dismiss = useCallback((id) => setToasts((prev) => prev.filter((x) => x.id !== id)), []);
  return { toasts, push, dismiss };
}

function ToastStack({ toasts, dismiss }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type || 'info'}`} onClick={() => dismiss(t.id)}>
          {t.title && <div className="toast-title">{t.title}</div>}
          <div className="toast-body">{t.body}</div>
        </div>
      ))}
    </div>
  );
}

// ─── drop zone (uses .drop-zone glass utility) ───────────────────────────────
function FileDropZone({ label, icon, accept, file, onSelect, disabled, hint }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = e.dataTransfer.files?.[0];
    if (!dropped) return;
    const exts = accept.split(',').map((s) => s.trim().toLowerCase());
    if (exts.some((ext) => dropped.name.toLowerCase().endsWith(ext))) onSelect(dropped);
  };

  const cls = ['drop-zone'];
  if (dragging) cls.push('dragging');
  if (file)     cls.push('has-file');

  return (
    <div
      className={cls.join(' ')}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      style={{ opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer', minHeight: 152 }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onSelect(f); }}
        disabled={disabled}
      />
      {file ? (
        <>
          <span className="glyph">{icon}</span>
          <div className="ttl green">{file.name}</div>
          <div className="sub">
            {(file.size / 1024).toFixed(file.size > 1024 * 1024 ? 0 : 1)}
            {file.size > 1024 * 1024 ? ' MB' : ' KB'} · click to replace
          </div>
        </>
      ) : (
        <>
          <span className="glyph">{icon}</span>
          <div className="ttl">{label}</div>
          <div className="sub">{hint}</div>
        </>
      )}
    </div>
  );
}

// ─── stat strip — big number cells + vertical chip row ───────────────────────
function StatStrip({ stats, entries, loading }) {
  if (!stats) return null;
  const verticalsCovered = Object.keys(stats.byVertical || {}).filter((k) => k !== 'unknown');
  const lastEntry = entries[entries.length - 1];
  const lastLabel = lastEntry
    ? new Date(lastEntry.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

  return (
    <>
      <div className="stat-strip">
        <div className="stat-cell">
          <div className="stat-label">Corpus size</div>
          <div className="stat-value">{stats.totalEntries}</div>
          <div className="stat-hint">entries indexed</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Verticals covered</div>
          <div className="stat-value">{verticalsCovered.length}<span style={{ fontSize: 14, color: 'var(--text-3)', fontWeight: 500 }}> / {VERTICALS.length}</span></div>
          <div className="stat-hint">unique verticals with at least one entry</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Last upload</div>
          <div className="stat-value" style={{ fontSize: 16, fontWeight: 600 }}>{lastLabel}</div>
          <div className="stat-hint">{loading ? 'refreshing…' : 'auto-syncs after each change'}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 24 }}>
        {VERTICALS.map((v) => {
          const count = stats.byVertical?.[v] || 0;
          return (
            <span key={v} className={`chip ${count > 0 ? 'on' : ''}`}>
              {v}{count > 0 ? ` · ${count}` : ''}
            </span>
          );
        })}
      </div>
    </>
  );
}

// ─── corpus entry row ────────────────────────────────────────────────────────
function EntryRow({ entry, onDelete, busy }) {
  const created = new Date(entry.createdAt);
  return (
    <div className="entry-row" style={{ fontSize: 13 }}>
      <div>
        <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>{entry.appName}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          {entry.packageName || entry.fileName || entry.id.slice(0, 8)}
        </div>
      </div>
      <span className={`chip ${entry.vertical ? 'blue' : ''}`} style={{ background: entry.vertical ? undefined : 'rgba(255,255,255,0.04)' }}>
        {entry.vertical || 'unknown'}
      </span>
      <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
        {entry.eventCount} events
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
        {created.toLocaleDateString()} · {created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
      <button
        onClick={() => onDelete(entry.id, entry.appName)}
        disabled={busy}
        className="btn"
        style={{
          padding: '6px 12px', fontSize: 11, fontFamily: 'var(--font-mono)',
          background: 'transparent', color: '#ef4444',
          border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6,
          cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1,
          transition: 'all 0.2s var(--ease-out)',
        }}
        onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = 'rgba(239,68,68,0.10)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        Delete
      </button>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────
export default function TrainingAdmin() {
  const [passcode, setPasscode] = useState(() => localStorage.getItem('ct_trainer_passcode') || '');
  const [authed, setAuthed]       = useState(false);
  const [authError, setAuthError] = useState('');

  const [apkFile, setApkFile]     = useState(null);
  const [sheetFile, setSheetFile] = useState(null);
  const [appName, setAppName]     = useState('');
  const [vertical, setVertical]   = useState('');
  const [showHelp, setShowHelp]   = useState(false);

  const [uploading, setUploading] = useState(false);
  const [entries, setEntries]     = useState([]);
  const [stats, setStats]         = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [busyId, setBusyId]       = useState(null);

  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  // ─── auth handshake ─────────────────────────────────────────────────────────
  const verifyPasscode = useCallback(async (pc) => {
    try {
      const r = await fetch(`${API}/training/stats`, { headers: { 'X-Trainer-Passcode': pc } });
      if (r.status === 401) { setAuthError('Wrong passcode.'); setAuthed(false); return false; }
      if (r.status === 503) { setAuthError('Training is disabled. Backend needs TRAINER_PASSCODE in .env.'); setAuthed(false); return false; }
      if (!r.ok)            { setAuthError(`Auth check failed (HTTP ${r.status}).`); setAuthed(false); return false; }
      const json = await r.json();
      setStats(json.stats);
      setAuthed(true);
      setAuthError('');
      localStorage.setItem('ct_trainer_passcode', pc);
      return true;
    } catch (err) {
      setAuthError(`Cannot reach backend: ${err.message}`);
      setAuthed(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const cached = localStorage.getItem('ct_trainer_passcode');
    if (cached) verifyPasscode(cached);
  }, [verifyPasscode]);

  // ─── refresh corpus + stats ────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!authed) return;
    setLoadingList(true);
    try {
      const [listRes, statsRes] = await Promise.all([
        fetch(`${API}/training`,       { headers: { 'X-Trainer-Passcode': passcode } }),
        fetch(`${API}/training/stats`, { headers: { 'X-Trainer-Passcode': passcode } }),
      ]);
      const listJson  = await listRes.json();
      const statsJson = await statsRes.json();
      setEntries(listJson.entries || []);
      setStats(statsJson.stats || null);
    } catch (err) {
      console.error('refresh failed', err);
    } finally {
      setLoadingList(false);
    }
  }, [authed, passcode]);

  useEffect(() => { if (authed) refresh(); }, [authed, refresh]);

  // ─── upload handler ─────────────────────────────────────────────────────────
  const handleUpload = async () => {
    if (!apkFile)   { pushToast({ type: 'error', title: 'Missing APK',   body: 'Drop an .apk into the left zone first.' });   return; }
    if (!sheetFile) { pushToast({ type: 'error', title: 'Missing sheet', body: 'Drop a .csv or .json event sheet first.' }); return; }

    setUploading(true);
    try {
      const form = new FormData();
      form.append('apk',   apkFile);
      form.append('sheet', sheetFile);
      if (appName.trim()) form.append('app_name', appName.trim());
      if (vertical)       form.append('vertical', vertical);

      const r = await fetch(`${API}/train`, {
        method: 'POST',
        headers: { 'X-Trainer-Passcode': passcode },
        body: form,
      });
      const json = await r.json();

      if (!r.ok || !json.success) {
        pushToast({ type: 'error', title: 'Upload failed', body: json.error || `HTTP ${r.status}` });
        return;
      }

      const warns = json.sheetWarnings || [];
      pushToast({
        type: 'success',
        title: `Added "${json.entry.appName}"`,
        body: `${json.entry.eventCount} events · corpus is now ${json.corpusSize} ${json.corpusSize === 1 ? 'entry' : 'entries'}` + (warns.length ? ` · ${warns.length} row warning(s)` : ''),
      });
      if (warns.length) {
        pushToast({ type: 'info', title: 'Sheet warnings', body: warns.slice(0, 4).join(' · '), ttl: 8000 });
      }
      setApkFile(null);
      setSheetFile(null);
      refresh();
    } catch (err) {
      pushToast({ type: 'error', title: 'Upload failed', body: err.message });
    } finally {
      setUploading(false);
    }
  };

  // ─── delete handler ─────────────────────────────────────────────────────────
  const handleDelete = async (id, appNameLabel) => {
    // eslint-disable-next-line no-restricted-globals
    if (!confirm(`Remove "${appNameLabel}" from the training corpus?`)) return;
    setBusyId(id);
    try {
      const r = await fetch(`${API}/training/${id}`, {
        method: 'DELETE',
        headers: { 'X-Trainer-Passcode': passcode },
      });
      if (r.ok) {
        pushToast({ type: 'info', body: `Removed "${appNameLabel}" from corpus.` });
        refresh();
      }
    } finally {
      setBusyId(null);
    }
  };

  // ─── CSV template download ──────────────────────────────────────────────────
  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'event_sheet_template.csv';
    a.click();
    URL.revokeObjectURL(url);
    pushToast({ type: 'info', body: 'event_sheet_template.csv downloaded.' });
  };

  // ─── logout ─────────────────────────────────────────────────────────────────
  const logout = () => {
    localStorage.removeItem('ct_trainer_passcode');
    setPasscode('');
    setAuthed(false);
    setEntries([]);
    setStats(null);
  };

  // ─── keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!authed) return;
    const onKey = (e) => {
      // ignore when typing in inputs
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); downloadTemplate(); }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); refresh(); }
      if (e.key === '?')                  { e.preventDefault(); setShowHelp((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line
  }, [authed, refresh]);

  // ─── passcode gate ──────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <>
        <ToastStack toasts={toasts} dismiss={dismissToast} />
        <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, position: 'relative' }}>
          <div className="hero-eyebrow"><span className="pulse-dot accent" /> Restricted area</div>
          <h1 className="hero-title gradient-text" style={{ fontSize: 42 }}>Training corpus.</h1>
          <p style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 16, marginBottom: 28, lineHeight: 1.65 }}>
            Trainer access only. Upload <code style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>(APK + event-sheet)</code> pairs to teach the AI your organisation's
            event vocabulary. New client scans will retrieve and mimic these examples automatically.
          </p>

          <div className="glass" style={{ padding: 20 }}>
            <label className="input-label">Trainer passcode</label>
            <input
              type="password"
              placeholder="Enter passcode"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') verifyPasscode(passcode); }}
              className="input-field"
              autoFocus
              style={{ width: '100%', marginBottom: 14, fontFamily: 'var(--font-mono)' }}
            />
            <button
              onClick={() => verifyPasscode(passcode)}
              disabled={!passcode}
              className="btn btn-primary"
              style={{ width: '100%' }}
            >
              Unlock <span className="arrow-x">→</span>
            </button>
            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              <span>press <span className="kbd">Enter</span> to unlock</span>
              <span>session-only · cached locally</span>
            </div>
          </div>

          {authError && (
            <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', fontSize: 13 }}>
              ⚠ {authError}
            </div>
          )}
        </div>
      </>
    );
  }

  // ─── authed UI ──────────────────────────────────────────────────────────────
  return (
    <>
      <ToastStack toasts={toasts} dismiss={dismissToast} />
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '36px 24px 80px', position: 'relative' }}>

        {/* Hero */}
        <div className="hero">
          <div className="hero-eyebrow">
            <span className="pulse-dot" />
            <span>Corpus · live</span>
            <span style={{ color: 'var(--text-3)', letterSpacing: 0, textTransform: 'none' }}>·</span>
            <span style={{ color: 'var(--text-3)', letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>
              {stats?.totalEntries ?? 0} {stats?.totalEntries === 1 ? 'entry' : 'entries'}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h1 className="hero-title">
                <span className="gradient-text">Training</span> <span style={{ color: 'var(--text-1)' }}>corpus.</span>
              </h1>
              <p className="hero-sub">
                Every upload becomes a retrievable few-shot exemplar &mdash; instantly. The next client APK scan
                will splice the closest entries into its prompt as &ldquo;highest-authority&rdquo; examples.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={refresh} className="btn btn-ghost" title="Refresh (R)" style={{ fontSize: 12 }}>
                ⟳ Refresh
              </button>
              <button onClick={logout} className="btn btn-ghost" style={{ fontSize: 12 }}>
                Sign out
              </button>
            </div>
          </div>
        </div>

        {/* Stats */}
        <StatStrip stats={stats} entries={entries} loading={loadingList} />

        {/* Upload card */}
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-1)', letterSpacing: '-0.01em' }}>
                Add a new training pair
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
                APK + event sheet (.csv or .json)
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="kbd">T</span><span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 6 }}>template</span>
              <span className="kbd">R</span><span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 6 }}>refresh</span>
              <span className="kbd">?</span><span style={{ fontSize: 11, color: 'var(--text-3)' }}>help</span>
              <button
                onClick={() => setShowHelp((v) => !v)}
                className="btn btn-ghost"
                style={{ marginLeft: 12, padding: '5px 11px', fontSize: 11, fontFamily: 'var(--font-mono)' }}
              >
                {showHelp ? '× hide' : '? format'}
              </button>
            </div>
          </div>

          {showHelp && (
            <div className="help-panel" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, color: 'var(--text-1)', marginBottom: 8 }}>Event sheet format</div>
              <div style={{ marginBottom: 8 }}>
                <b>Columns (header row required):</b><br />
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  event_name, category, priority, trigger_description, properties, reason
                </code>
              </div>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                <li><b>category</b> must be one of <code>Acquisition | Activation | Retention | Revenue | Referral</code>.</li>
                <li><b>priority</b> must be one of <code>must-have | recommended | nice-to-have</code>.</li>
                <li><b>properties</b> uses <code>|</code> (pipe) separator: <code>product_id|price|category</code>. Commas would split the row.</li>
                <li><b>Cells with commas, quotes or newlines must be double-quoted</b>: <code>"User taps Cart, then Checkout"</code>.</li>
                <li>Bad rows become warnings &mdash; the rest of the sheet still uploads.</li>
                <li>JSON sheets work too &mdash; array of objects with camelCase keys (<code>eventName</code>, <code>triggerDescription</code>, <code>suggestedProperties</code>).</li>
              </ul>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
            <FileDropZone
              label="Drop APK here"
              icon="📱"
              accept=".apk"
              file={apkFile}
              onSelect={setApkFile}
              disabled={uploading}
              hint="Android .apk · up to 500 MB"
            />
            <FileDropZone
              label="Drop event sheet here"
              icon="📋"
              accept=".csv,.json,.tsv,.txt"
              file={sheetFile}
              onSelect={setSheetFile}
              disabled={uploading}
              hint=".csv / .json — press T for a template"
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
            <div>
              <label className="input-label">App name <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(optional)</span></label>
              <input
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="Detected from APK if blank"
                disabled={uploading}
                className="input-field"
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label className="input-label">Vertical <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(filters retrieval)</span></label>
              <select
                value={vertical}
                onChange={(e) => setVertical(e.target.value)}
                disabled={uploading}
                className="input-field"
                style={{ width: '100%', fontFamily: 'var(--font-mono)', cursor: 'pointer' }}
              >
                <option value="">— pick one —</option>
                {VERTICALS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14 }}>
            <button
              onClick={downloadTemplate}
              className="btn btn-ghost"
              style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}
              title="Download template (T)"
            >
              ↓ CSV template
            </button>

            <button
              onClick={handleUpload}
              disabled={uploading || !apkFile || !sheetFile}
              className="btn btn-primary"
              style={{ minWidth: 200 }}
            >
              {uploading ? (
                <>Uploading<span className="dots" style={{ display: 'inline-block', width: 16 }}>…</span></>
              ) : (
                <>Add to corpus <span className="arrow-x">→</span></>
              )}
            </button>
          </div>
        </div>

        {/* Corpus list */}
        <div style={{ marginTop: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Corpus contents
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-1)', marginTop: 2 }}>
                {entries.length} {entries.length === 1 ? 'app' : 'apps'} trained
              </div>
            </div>
            {loadingList && (
              <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="pulse-dot accent" /> refreshing…
              </div>
            )}
          </div>

          <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
            {entries.length === 0 ? (
              <div style={{ padding: '48px 24px', textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>📚</div>
                <div style={{ fontSize: 14, color: 'var(--text-1)', fontWeight: 600, marginBottom: 6 }}>
                  Corpus is empty
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.6, maxWidth: 420, margin: '0 auto' }}>
                  Upload your first (APK + sheet) pair above &mdash; the very next client scan will
                  use it as a retrieved exemplar.
                </div>
              </div>
            ) : (
              entries.map((e) => (
                <EntryRow key={e.id} entry={e} onDelete={handleDelete} busy={busyId === e.id} />
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
