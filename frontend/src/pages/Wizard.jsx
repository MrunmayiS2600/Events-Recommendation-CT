import React, { useState, useCallback, useRef, useEffect } from 'react';
import CampaignSuggestions from './CampaignSuggestions';

const API = process.env.REACT_APP_API_URL ? `${process.env.REACT_APP_API_URL}/api` : '/api';

const PRIORITY_META = {
  'must-have':    { label: 'Must Have',    color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.3)',  icon: '⚡' },
  'recommended':  { label: 'Recommended',  color: '#3b82f6', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.3)', icon: '✦' },
  'nice-to-have': { label: 'Nice to Have', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)',border: 'rgba(167,139,250,0.3)',icon: '◎' },
};

const CATEGORY_COLORS = {
  'Acquisition': '#f59e0b',
  'Activation':  '#3b82f6',
  'Retention':   '#22c55e',
  'Revenue':     '#ff5533',
  'Referral':    '#a78bfa',
};

// ─── Badges ──────────────────────────────────────────────────────────────────
function PriorityBadge({ priority }) {
  const m = PRIORITY_META[priority] || PRIORITY_META['nice-to-have'];
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 999,
      fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.05em', background: m.bg,
      border: `1px solid ${m.border}`, color: m.color,
    }}>
      {m.icon} {m.label}
    </span>
  );
}

function CategoryBadge({ category }) {
  const color = CATEGORY_COLORS[category] || '#9aa0ae';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: `${color}18`, color, border: `1px solid ${color}30`,
    }}>
      {category}
    </span>
  );
}

// ─── EventCard ────────────────────────────────────────────────────────────────
function EventCard({ event, selected, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  const m = PRIORITY_META[event.priority] || PRIORITY_META['nice-to-have'];

  return (
    <div style={{
      border: `1px solid ${selected ? m.border : 'var(--border)'}`,
      borderRadius: 'var(--radius)',
      background: selected ? m.bg : 'var(--bg-input)',
      marginBottom: 10,
      transition: 'all 0.15s',
      overflow: 'hidden',
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        <div
          onClick={e => { e.stopPropagation(); onToggle(); }}
          style={{
            width: 20, height: 20, borderRadius: 5, flexShrink: 0,
            border: `2px solid ${selected ? m.color : 'var(--border-hi)'}`,
            background: selected ? m.color : 'transparent',
            display: 'grid', placeItems: 'center', cursor: 'pointer',
            transition: 'all 0.15s',
          }}
        >
          {selected && <span style={{ color: 'white', fontSize: 12, lineHeight: 1 }}>✓</span>}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>
              {event.eventName}
            </span>
            <PriorityBadge priority={event.priority} />
            <CategoryBadge category={event.category} />
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>
            {event.reason}
          </p>
        </div>

        <span style={{
          color: 'var(--text-3)', fontSize: 18, flexShrink: 0,
          transition: 'transform 0.15s',
          transform: expanded ? 'rotate(180deg)' : 'none',
        }}>
          ⌄
        </span>
      </div>

      {expanded && (
        <div style={{ padding: '0 16px 16px 48px', borderTop: '1px solid var(--border)' }}>
          <div style={{ paddingTop: 14 }}>
            <div style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 6,
            }}>
              When to fire
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>
              {event.triggerDescription}
            </p>
          </div>

          {event.suggestedProperties?.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 8,
              }}>
                Suggested properties
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {event.suggestedProperties.map(prop => (
                  <code key={prop} style={{
                    padding: '3px 8px', borderRadius: 5, fontSize: 11,
                    background: '#0d0f14', border: '1px solid var(--border)',
                    color: '#a8d8a8', fontFamily: 'var(--font-mono)',
                  }}>
                    {prop}
                  </code>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── APK Meta Panel ───────────────────────────────────────────────────────────
function ApkMetaPanel({ meta }) {
  if (!meta) return null;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      gap: 10, marginTop: 14, paddingTop: 14,
      borderTop: '1px solid var(--border)',
    }}>
      {[
        { label: '📦 Package',    value: meta.packageName || '–' },
        { label: '🖥 Screens',    value: `${meta.screensDetected} detected` },
        { label: '⚙️ Activities', value: `${meta.activitiesFound} found` },
        { label: '🔑 Permissions', value: meta.permissions?.slice(0, 3).join(', ') || '–' },
        { label: '🧩 SDKs',       value: meta.sdks?.slice(0, 3).join(', ') || 'Standard' },
        { label: '🔗 Deep Links', value: meta.deepLinks?.join(', ') || 'None' },
      ].map(({ label, value }) => (
        <div key={label} style={{
          padding: '9px 12px', borderRadius: 8,
          background: 'var(--bg-input)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 3 }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', wordBreak: 'break-all' }}>
            {value}
          </div>
        </div>
      ))}

      {meta.features?.length > 0 && (
        <div style={{
          padding: '9px 12px', borderRadius: 8, gridColumn: '1 / -1',
          background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', fontFamily: 'var(--font-mono)', marginBottom: 5 }}>
            📱 INFERRED FEATURES (from permissions)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {meta.features.map(f => (
              <span key={f} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 4,
                background: 'rgba(167,139,250,0.12)', color: '#a78bfa',
                border: '1px solid rgba(167,139,250,0.25)', fontWeight: 600,
              }}>
                {f}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Journey Builder Panel ────────────────────────────────────────────────────
// Sits in step 3 under the event review grid. Lets the user describe a use
// case in free text and pick the channels they're willing to send on; calls
// /api/generate-journeys and renders the two variants side-by-side as a
// vertical step timeline (trigger / wait / send / branch).
const ALL_CHANNELS = [
  { id: 'push',     label: 'Push',     emoji: '📲' },
  { id: 'email',    label: 'Email',    emoji: '✉️' },
  { id: 'in-app',   label: 'In-App',   emoji: '🪟' },
  { id: 'sms',      label: 'SMS',      emoji: '💬' },
  { id: 'whatsapp', label: 'WhatsApp', emoji: '📱' },
  { id: 'web',      label: 'Web Push', emoji: '🌐' },
];

function JourneyBuilderPanel({
  useCase, onUseCaseChange,
  channels, onChannelsChange,
  loading, error, journeys, selectedCount, onGenerate,
}) {
  const toggleChannel = (id) => {
    if (channels.includes(id)) onChannelsChange(channels.filter((c) => c !== id));
    else                       onChannelsChange([...channels, id]);
  };

  return (
    <div className="card jb-card" style={{ marginTop: 8 }}>
      <div className="card-title" style={{ marginBottom: 4 }}>
        Journey Builder
        <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text-2)', fontSize: 12 }}>
          ⚡ Generate 2 journey variants for a specific use case
        </span>
      </div>
      <p style={{ color: 'var(--text-2)', fontSize: 12, margin: '4px 0 14px' }}>
        Describe what you want this journey to achieve. We&rsquo;ll use your <strong>{selectedCount} selected event{selectedCount === 1 ? '' : 's'}</strong> as triggers and only send on the channels you approve.
      </p>

      <div className="jb-row">
        <label className="jb-label" htmlFor="jb-usecase">Use case</label>
        <textarea
          id="jb-usecase"
          className="jb-textarea"
          rows={2}
          placeholder="e.g. Reduce cart abandonment within 24 hours, or onboard new users to their first booking in 7 days"
          value={useCase}
          onChange={(e) => onUseCaseChange(e.target.value)}
          disabled={loading}
          maxLength={300}
        />
      </div>

      <div className="jb-row">
        <label className="jb-label">Approved channels</label>
        <div className="jb-channels">
          {ALL_CHANNELS.map((c) => {
            const active = channels.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                className={'jb-channel' + (active ? ' is-active' : '')}
                onClick={() => toggleChannel(c.id)}
                disabled={loading}
                aria-pressed={active}
              >
                <span aria-hidden="true">{c.emoji}</span>&nbsp;&nbsp;{c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="jb-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onGenerate}
          disabled={loading || !useCase.trim() || selectedCount === 0 || channels.length === 0}
          style={{ minWidth: 220 }}
        >
          {loading ? <><span className="spinner" /> Generating variants…</> : <>Generate 2 Journey Variants <span className="arrow-x">→</span></>}
        </button>
        {selectedCount === 0 && (
          <span style={{ marginLeft: 12, color: 'var(--text-3)', fontSize: 12 }}>Select at least one event above first.</span>
        )}
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginTop: 14, fontSize: 12 }}>
          {error}
        </div>
      )}

      {journeys && Array.isArray(journeys.variants) && journeys.variants.length > 0 && (
        <div className="jb-variants">
          {journeys.variants.map((v, idx) => (
            <JourneyVariantCard key={v.id || idx} variant={v} index={idx} />
          ))}
        </div>
      )}
    </div>
  );
}

function JourneyVariantCard({ variant, index }) {
  const accent = index === 0 ? 'jb-var-conservative' : 'jb-var-aggressive';
  const badge  = index === 0 ? 'Conservative' : 'Aggressive';
  return (
    <div className={'jb-variant ' + accent}>
      <div className="jb-variant-head">
        <span className="jb-variant-badge">{badge}</span>
        <div className="jb-variant-name">{variant.name}</div>
      </div>
      {variant.description && <p className="jb-variant-desc">{variant.description}</p>}

      {(variant.channels || []).length > 0 && (
        <div className="jb-variant-channels">
          {variant.channels.map((c) => (
            <span key={c} className="jb-pill">{c}</span>
          ))}
        </div>
      )}

      <div className="jb-variant-section">
        <div className="jb-variant-section-label">GOAL</div>
        <div className="jb-variant-section-value">{variant.goal || '—'}</div>
      </div>

      <div className="jb-variant-section">
        <div className="jb-variant-section-label">STEPS</div>
        <ol className="jb-steps">
          {(variant.steps || []).map((step, i) => (
            <JourneyStep key={i} step={step} />
          ))}
        </ol>
      </div>

      {(variant.kpis || []).length > 0 && (
        <div className="jb-variant-section">
          <div className="jb-variant-section-label">KPIs</div>
          <div className="jb-variant-channels">
            {variant.kpis.map((k) => <span key={k} className="jb-pill jb-pill-kpi">{k}</span>)}
          </div>
        </div>
      )}

      {variant.successMetric && (
        <div className="jb-variant-section">
          <div className="jb-variant-section-label">SUCCESS METRIC</div>
          <div className="jb-variant-section-value jb-success">{variant.successMetric}</div>
        </div>
      )}
    </div>
  );
}

function JourneyStep({ step }) {
  if (!step || typeof step !== 'object') return null;
  const t = (step.type || '').toLowerCase();
  if (t === 'trigger') {
    return (
      <li className="jb-step jb-step-trigger">
        <span className="jb-step-tag">TRIGGER</span>
        <div className="jb-step-body">
          <strong>{step.event || '—'}</strong>
          {step.description && <div className="jb-step-sub">{step.description}</div>}
        </div>
      </li>
    );
  }
  if (t === 'wait') {
    return (
      <li className="jb-step jb-step-wait">
        <span className="jb-step-tag">WAIT</span>
        <div className="jb-step-body">
          <strong>{step.duration || '—'}</strong>
          {step.condition && <div className="jb-step-sub">{step.condition}</div>}
        </div>
      </li>
    );
  }
  if (t === 'send') {
    return (
      <li className="jb-step jb-step-send">
        <span className="jb-step-tag">SEND · {(step.channel || '').toUpperCase()}</span>
        <div className="jb-step-body">
          {step.title && <strong>{step.title}</strong>}
          {step.body  && <div className="jb-step-sub">{step.body}</div>}
          {step.cta   && <div className="jb-step-cta">CTA: {step.cta}</div>}
        </div>
      </li>
    );
  }
  if (t === 'branch') {
    return (
      <li className="jb-step jb-step-branch">
        <span className="jb-step-tag">BRANCH</span>
        <div className="jb-step-body">
          <strong>{step.condition || 'condition'}</strong>
          {Array.isArray(step.yes) && step.yes.length > 0 && (
            <div className="jb-branch-side">
              <div className="jb-branch-label">YES →</div>
              <ol className="jb-steps">{step.yes.map((s, i) => <JourneyStep key={i} step={s} />)}</ol>
            </div>
          )}
          {Array.isArray(step.no) && step.no.length > 0 && (
            <div className="jb-branch-side">
              <div className="jb-branch-label">NO →</div>
              <ol className="jb-steps">{step.no.map((s, i) => <JourneyStep key={i} step={s} />)}</ol>
            </div>
          )}
        </div>
      </li>
    );
  }
  // Unknown step type — show raw
  return (
    <li className="jb-step">
      <span className="jb-step-tag">{(step.type || 'STEP').toUpperCase()}</span>
      <div className="jb-step-body"><pre style={{ margin: 0, fontSize: 10 }}>{JSON.stringify(step, null, 2)}</pre></div>
    </li>
  );
}

// ─── APK Upload Zone ──────────────────────────────────────────────────────────
function ApkUploadZone({ onFileSelect, selectedFile, scanning }) {
  const inputRef  = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.endsWith('.apk')) onFileSelect(file);
  };

  const handleChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onFileSelect(file);
  };

  return (
    <div
      onClick={() => !scanning && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      style={{
        border: `2px dashed ${dragging ? 'var(--accent)' : selectedFile ? '#22c55e' : 'var(--border-hi)'}`,
        borderRadius: 'var(--radius)',
        padding: '32px 24px',
        textAlign: 'center',
        cursor: scanning ? 'not-allowed' : 'pointer',
        background: dragging
          ? 'rgba(255,85,51,0.05)'
          : selectedFile
            ? 'rgba(34,197,94,0.05)'
            : 'var(--bg-input)',
        transition: 'all 0.2s',
        opacity: scanning ? 0.6 : 1,
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".apk"
        style={{ display: 'none' }}
        onChange={handleChange}
        disabled={scanning}
      />

      {selectedFile ? (
        <>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📱</div>
          <div style={{ fontWeight: 700, color: '#22c55e', fontFamily: 'var(--font-mono)', fontSize: 14, marginBottom: 4 }}>
            {selectedFile.name}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {(selectedFile.size / 1024 / 1024).toFixed(1)} MB — click to change
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⬆️</div>
          <div style={{ fontWeight: 700, color: 'var(--text-1)', fontSize: 15, marginBottom: 6 }}>
            Drop your APK here or click to browse
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: 1.6 }}>
            Supports Android APK files up to 500 MB<br />
            No device, Java, or APKTool required — pure analysis
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Wizard Component ────────────────────────────────────────────────────
export default function Wizard() {
  const [step, setStep]             = useState(1);
  const [scanMode, setScanMode]     = useState('url');   // 'url' | 'apk'
  const [url, setUrl]               = useState('');
  const [apkFile, setApkFile]       = useState(null);
  // Optional hints typed by the uploader. They're not required, but providing
  // them dramatically improves vertical classification — especially for indie
  // / heavily-obfuscated APKs where the manifest alone can't reveal the app's
  // purpose. Sent as form fields to /api/scan-apk.
  const [apkAppName, setApkAppName] = useState('');
  const [apkRefUrl, setApkRefUrl]   = useState('');
  const [scanning, setScanning]     = useState(false);
  const [scanError, setScanError]   = useState('');
  const [result, setResult]         = useState(null);
  const [selected, setSelected]     = useState(new Set());
  const [filterPriority, setFilter] = useState('all');
  const [copiedCode, setCopiedCode] = React.useState(false);
  // How many events the AI should generate. Lower = cheaper (less tokens),
  // faster, narrower coverage. Higher = more comprehensive, more tokens used.
  const [eventCount, setEventCount] = useState(50);

  // ── Journey Builder state ────────────────────────────────────────────────
  // Free-text use case the user types (e.g. "Reduce cart abandonment in 24h").
  // Combined with the selected events + vertical + approved channels, sent to
  // /api/generate-journeys to produce two journey variants (Conservative +
  // Aggressive).
  const [journeyUseCase, setJourneyUseCase]   = useState('');
  const [journeyChannels, setJourneyChannels] = useState(['push', 'email', 'in-app']);
  const [journeys, setJourneys]               = useState(null);
  const [journeyLoading, setJourneyLoading]   = useState(false);
  const [journeyError, setJourneyError]       = useState('');

  // ── Google Sheets push state ─────────────────────────────────────────────
  const [sheetPushStatus, setSheetPushStatus] = useState(null); // null | 'pushing' | 'done' | 'error'
  const [sheetUrl, setSheetUrl] = useState(null);

  // ── localStorage persistence ─────────────────────────────────────────────
  // Survives page refresh. We deliberately do NOT persist transient flags
  // (scanning, scanError, copiedCode, journeyLoading, journeyError) or the
  // raw APK File object (can't be serialised — and once we have a result,
  // the file isn't needed anyway).
  const STORAGE_KEY = 'ct_wizard_v1';
  const hydratedRef = React.useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const s = JSON.parse(saved);
      if (typeof s.step      === 'number')  setStep(s.step);
      if (typeof s.scanMode  === 'string')  setScanMode(s.scanMode);
      if (typeof s.url       === 'string')  setUrl(s.url);
      if (typeof s.apkAppName=== 'string')  setApkAppName(s.apkAppName);
      if (typeof s.apkRefUrl === 'string')  setApkRefUrl(s.apkRefUrl);
      if (s.result)                         setResult(s.result);
      if (Array.isArray(s.selected))        setSelected(new Set(s.selected));
      if (typeof s.filterPriority === 'string') setFilter(s.filterPriority);
      if (typeof s.eventCount === 'number') setEventCount(s.eventCount);
      if (typeof s.journeyUseCase === 'string') setJourneyUseCase(s.journeyUseCase);
      if (Array.isArray(s.journeyChannels)) setJourneyChannels(s.journeyChannels);
      if (s.journeys)                       setJourneys(s.journeys);
    } catch (_) { /* corrupted state — ignore */ }
  }, []);
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        step, scanMode, url, apkAppName, apkRefUrl,
        result,
        selected: [...selected],
        filterPriority, eventCount,
        journeyUseCase, journeyChannels, journeys,
      }));
    } catch (_) { /* quota full — skip */ }
  }, [step, scanMode, url, apkAppName, apkRefUrl, result, selected, filterPriority, eventCount, journeyUseCase, journeyChannels, journeys]);

  // ── New Scan / reset everything ──────────────────────────────────────────
  const resetWizard = useCallback(() => {
    // eslint-disable-next-line no-restricted-globals, no-alert
    if (typeof window !== 'undefined' && !window.confirm('Start a new scan? Your current results will be cleared.')) return;
    setStep(1);
    setScanMode('url');
    setUrl('');
    setApkFile(null);
    setApkAppName('');
    setApkRefUrl('');
    setScanError('');
    setResult(null);
    setSelected(new Set());
    setFilter('all');
    setJourneyUseCase('');
    setJourneyChannels(['push', 'email', 'in-app']);
    setJourneys(null);
    setJourneyError('');
    setSheetPushStatus(null);
    setSheetUrl(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }, []);

  // ── Generate journey variants from current selection ─────────────────────
  const handleGenerateJourneys = useCallback(async () => {
    if (!result || !journeyUseCase.trim()) return;
    if (selected.size === 0) {
      setJourneyError('Select at least one event before generating journeys.');
      return;
    }
    if (journeyChannels.length === 0) {
      setJourneyError('Pick at least one channel.');
      return;
    }
    setJourneyLoading(true);
    setJourneyError('');
    try {
      const selectedEvents = result.recommendedEvents.filter((e) => selected.has(e.eventName));
      const res = await fetch(`${API}/generate-journeys`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          useCase:             journeyUseCase.trim(),
          selectedEvents,
          vertical:            result.detectedVertical || result.businessVertical || '',
          businessDescription: result.businessDescription || '',
          channels:            journeyChannels,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Journey generation failed');
      setJourneys(data);
    } catch (err) {
      setJourneyError(err.message);
    } finally {
      setJourneyLoading(false);
    }
  }, [result, selected, journeyUseCase, journeyChannels]);

  // ── Scan URL ────────────────────────────────────────────────────────────────
  const handleScan = useCallback(async () => {
    if (!url.trim()) return;
    setScanning(true);
    setScanError('');
    setResult(null);
    setStep(2);

    try {
      const res  = await fetch(`${API}/scan`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: url.trim(), eventCount }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Scan failed');
      setResult(data);
      setSelected(new Set(data.recommendedEvents.filter(e => e.priority === 'must-have').map(e => e.eventName)));
      setStep(3);
    } catch (err) {
      setScanError(err.message);
      setStep(1);
    } finally {
      setScanning(false);
    }
  }, [url, eventCount]);

  // ── Scan APK ────────────────────────────────────────────────────────────────
  const handleApkScan = useCallback(async () => {
    if (!apkFile) return;
    setScanning(true);
    setScanError('');
    setResult(null);
    setStep(2);

    try {
      const formData = new FormData();
      formData.append('apk', apkFile);
      formData.append('event_count', String(eventCount));
      if (apkAppName.trim()) formData.append('appName',      apkAppName.trim());
      if (apkRefUrl.trim())  formData.append('referenceUrl', apkRefUrl.trim());

      const res = await fetch(`${API}/scan-apk`, {
        method: 'POST',
        body:   formData,
        // Note: do NOT set Content-Type — browser sets it with boundary automatically
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'APK scan failed');
      setResult(data);
      setSelected(new Set(data.recommendedEvents.filter(e => e.priority === 'must-have').map(e => e.eventName)));
      setStep(3);
    } catch (err) {
      setScanError(err.message);
      setStep(1);
    } finally {
      setScanning(false);
    }
  }, [apkFile, eventCount, apkAppName, apkRefUrl]);

  const toggleEvent = name => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const selectAll  = () => setSelected(new Set(result.recommendedEvents.map(e => e.eventName)));
  const selectMust = () => setSelected(new Set(result.recommendedEvents.filter(e => e.priority === 'must-have').map(e => e.eventName)));
  const clearAll   = () => setSelected(new Set());

  const isApk = result?.websiteType === 'Android Mobile Application';

  // ── Hoisted helpers (used by both downloadCSV and handlePushToSheet) ────────
  // Humanise a property name: cart_total → "Cart Total", productId → "Product Id".
  const humanise = (p) => {
    if (!p) return '';
    return String(p)
      .replace(/[_\-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  // Infer the CleverTap-supported data type from the property name.
  // Order matters — Boolean is checked before Integer, etc.
  const inferType = (p) => {
    const s = (p || '').toLowerCase();
    if (/^(is|has|can|should|did|was|enable|disable)_|_flag$|^success$|verified|_enabled$/.test(s)) return 'Boolean';
    if (/(^|_)(date|time|timestamp|_at)(_|$)/.test(s) || s.endsWith('_at')) return 'Date';
    if (/(price|amount|total|cost|revenue|discount|tax|fare|fee|rate|score|rating|distance|latitude|longitude|lat|lng|balance)/.test(s)) return 'Float';
    if (/(\bnumber\b|number_of|count|qty|quantity|num_|_num|index|position|page|secs|mins|minutes|hours|days|weeks|months|year|level|size|length|duration|attempts|points|stars|results)/.test(s)) return 'Integer';
    return 'String';
  };

  // Short, human-friendly description of what a property holds.
  const describe = (p) => {
    const s  = (p || '').toLowerCase();
    const t  = inferType(p);
    if (s.endsWith('_id') || s === 'id')                return `Unique identifier (${humanise(p).toLowerCase()})`;
    if (s.startsWith('number_of') || s.includes('count')) return `Count of ${humanise(p).toLowerCase().replace(/^number of /, '').replace(/ count$/, '')}`;
    if (s.includes('email'))                            return 'Email address';
    if (s.includes('phone'))                            return 'Phone number';
    if (s.includes('name'))                             return `Name value for ${humanise(p).toLowerCase()}`;
    if (s.includes('category') || s.includes('type'))   return 'Category / type bucket';
    if (s.includes('status'))                           return 'Status / outcome (e.g. success / failure)';
    if (s.includes('method'))                           return 'Method or channel used (e.g. card, UPI, wallet)';
    if (s.includes('source') || s.includes('channel'))  return 'Source / channel of the action';
    if (s.includes('url') || s.includes('link'))        return 'URL or deep link';
    if (t === 'Boolean')                                return 'True / false flag';
    if (t === 'Date')                                   return 'Timestamp when the action occurred';
    if (t === 'Float')                                  return 'Numeric value (currency / measurement)';
    if (t === 'Integer')                                return 'Count or whole number';
    return `Value associated with ${humanise(p).toLowerCase()}`;
  };

  // ── Download CSV ─────────────────────────────────────────────────────────────
  const downloadCSV = () => {
    const eventsToExport = result.recommendedEvents.filter(e => selected.has(e.eventName));
    const escape = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const row    = (...cols) => cols.map(escape).join(',');

    // ── Build CSV in the CleverTap reference template shape ──
    // Columns: # | Event | Event Property | When to raise | Data Type | Important Note
    const lines = [];
    // 1. Title / preamble row
    lines.push(row('These are sample values added by CleverTap. Please use these for reference only**', '', '', '', '', ''));
    // 2. Header row #1
    lines.push(row('#', 'Event', 'Event Property', 'When to raise', 'Data Type', 'Important Note'));
    // 3. Instructions row — verbatim from the CleverTap intake template
    lines.push(row(
      'Instructions',
      'Name of the event (user activity) that you would like to capture\n\nExample :\n   - Signup/Login\n   - Product Search\n   - Page Viewed',
      'Additional information about the event.\nExample: Product Search (Product Name, Category, Price) - Page Viewed (URL, Page Source)',
      'On what condition that you would like to raise this event to CleverTap\nExample : - Product Search (When user enter some words on search bar) - Page Viewed (When particular page is opened)',
      'Data type of properties.\nExample:\n- String\n- Integer\n- Float\n- Double\n- Boolean\n- Date Format - new date(), "$D_epcohinseconds"',
      'CleverTap by default tracks the below events:\n- App Installed\n- App Launched\n- App Uninstalled\n- Notification Sent\n- Notification Viewed\n- Notification Clicked\n- Identity Set\n- Identity Reset\n- Identity Error\nRead more here: https://developer.clevertap.com/docs/concepts-events#section-system-events',
    ));
    // 4. Blank separator
    lines.push(row('', '', '', '', '', ''));
    // 5. Header row #2 — data starts after this
    lines.push(row('#', 'Event', 'Event Property', 'When to raise', 'Data Type', 'Important Note'));

    // 6. Numbered events with each property on its own indented row
    eventsToExport.forEach((e, idx) => {
      lines.push(row(String(idx + 1), e.eventName, '', e.triggerDescription || '', '', ''));
      for (const propRaw of (e.suggestedProperties || [])) {
        lines.push(row('', '', humanise(propRaw), describe(propRaw), inferType(propRaw), ''));
      }
      lines.push(row('', '', '', '', '', ''));
    });

    const csv  = lines.join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href  = URL.createObjectURL(blob);
    const name = isApk
      ? (result.apkMeta?.packageName || 'app').split('.').pop()
      : (() => { try { return new URL(result.url).hostname.replace('www.', ''); } catch { return 'website'; } })();
    link.download = `clevertap-events-${name}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ── Push to Google Sheet ─────────────────────────────────────────────────────
  const handlePushToSheet = async () => {
    const eventsToExport = result.recommendedEvents.filter(e => selected.has(e.eventName));
    const payload = eventsToExport.map(e => ({
      eventName: e.eventName,
      triggerDescription: e.triggerDescription || '',
      properties: (e.suggestedProperties || []).map(p => ({
        name: humanise(p),
        description: describe(p),
        dataType: inferType(p),
      })),
    }));

    setSheetPushStatus('pushing');
    try {
      const res = await fetch(`${API}/push-to-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          events: payload,
          isApk,
          appLabel: isApk
            ? (result.apkMeta?.packageName || 'app').split('.').pop()
            : (() => { try { return new URL(result.url).hostname.replace('www.', ''); } catch { return 'website'; } })(),
          scannedUrl: isApk ? (result.apkMeta?.packageName || '') : (result.url || url),
          vertical: result.businessVertical || '',
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Push failed');
      setSheetUrl(data.sheetUrl);
      setSheetPushStatus('done');
    } catch (err) {
      console.error(err);
      setSheetPushStatus('error');
    }
  };

  // ── SDK code generation ──────────────────────────────────────────────────────
  const sampleValue = (prop) => {
    const p = prop.toLowerCase();
    if (p.includes('date') || p.includes('time') || p === 'timestamp') return 'new Date()';
    if (p.includes('price') || p.includes('amount') || p.includes('value') || p.includes('revenue')) return '59.99';
    if (p.includes('quantity') || p.includes('count') || p.includes('units')) return '1';
    if (p.includes('rating') || p.includes('score')) return '4.5';
    if (p.includes('url') || p.includes('link')) return 'window.location.href';
    if (p.includes('id')) return '"ID-001"';
    if (p.includes('email')) return '"user@example.com"';
    if (p.includes('phone')) return '"+91XXXXXXXXXX"';
    if (p.includes('status')) return '"active"';
    if (p.includes('platform') || p.includes('device')) return isApk ? '"Android"' : '"Web"';
    if (p.includes('version')) return '"1.0.0"';
    if (p.includes('plan')) return '"Basic"';
    return '"value"';
  };

  const isChargedEvent = (name) =>
    /purchas|payment.?success|payment.?complet|order.?success|order.?confirm|transaction.?success|charged/i.test(name);

  const buildChargedCode = (e) => {
    const itemProps = (e.suggestedProperties || [])
      .filter(p => !/amount|payment|charged.?id|transaction.?id|order.?id/i.test(p));
    const itemLines = itemProps.length > 0
      ? itemProps.map(p => '      "' + p + '": ' + sampleValue(p)).join(',\n')
      : '      "Product Name": "Sample Product",\n      "Quantity": 1,\n      "Price": 59.99';

    return (
      '// ⚡ CleverTap special Charged event\n' +
      'clevertap.event.push("Charged", {\n' +
      '  "Amount": 299.00,\n' +
      '  "Payment Mode": "UPI",\n' +
      '  "Charged ID": "ORD-001",\n' +
      '  "Items": [{\n' + itemLines + '\n  }]\n' +
      '});'
    );
  };

  const singleEventCode = (e) => {
    if (isChargedEvent(e.eventName)) return buildChargedCode(e);
    const props = e.suggestedProperties || [];
    const lines  = props.length > 0
      ? props.map((p, i) => '  "' + p + '": ' + sampleValue(p) + (i < props.length - 1 ? ',' : ''))
      : ['  "Date": new Date()'];
    return 'clevertap.event.push("' + e.eventName + '", {\n' + lines.join('\n') + '\n});';
  };

  const generateSDKCode = (events) => events.map(e => singleEventCode(e)).join('\n\n');

  const copySDKCode = async () => {
    const list = result.recommendedEvents.filter(e => selected.has(e.eventName));
    try { await navigator.clipboard.writeText(generateSDKCode(list)); } catch {}
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2500);
  };

  const visibleEvents = result?.recommendedEvents?.filter(e =>
    filterPriority === 'all' || e.priority === filterPriority
  ) || [];

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div>
      {step !== 1 && step !== 2 && (
        <div className="page-header page-header-row">
          <div className="page-header-text">
            <h1>Event Recommendation Engine</h1>
            <p>Scan a website URL or upload an Android APK — we'll analyse it and recommend the right CleverTap events.</p>
          </div>
          {result && (
            <button
              type="button"
              className="btn btn-ghost btn-new-scan"
              onClick={resetWizard}
              title="Clear current results and go back to URL / APK input"
            >
              <span aria-hidden="true">↺</span>&nbsp;&nbsp;New Scan
            </button>
          )}
        </div>
      )}

      {/* ── Step 1: Hero input ── */}
      {(step === 1 || step === 2) && (
        <>
          {/* Centered hero block */}
          <section className="hero">
            <span className="hero-eyebrow">
              <span className="pulse-dot" /> AI-powered event taxonomy
            </span>
            <h1 className="hero-title">
              Generate <span className="gradient">CleverTap events</span><br />
              for any app or site.
            </h1>
            <p className="hero-sub">
              Paste a URL or drop an APK — we&rsquo;ll analyse it, infer the business vertical,
              and produce 50&nbsp;tailored events with categories, priorities and properties.
            </p>

            {/* Mode pills */}
            <div className="mode-tabs" role="tablist">
              {[
                { id: 'url', icon: '🌐', label: 'Website URL' },
                { id: 'apk', icon: '📱', label: 'Android APK' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={scanMode === tab.id}
                  onClick={() => { setScanMode(tab.id); setScanError(''); }}
                  disabled={scanning}
                  className={'mode-tab' + (scanMode === tab.id ? ' active' : '')}
                >
                  <span>{tab.icon}</span> {tab.label}
                </button>
              ))}
            </div>

            {/* Event-count picker — drives prompt size + max_tokens.
                Lower = fewer tokens, faster, narrower coverage.
                Higher = more comprehensive but more expensive.            */}
            <div className="count-picker">
              <div className="count-picker-label">
                Events to generate
                <span className="count-picker-hint">
                  {eventCount <= 15 ? 'lean · fastest · cheapest' :
                   eventCount <= 30 ? 'balanced · narrower coverage' :
                   eventCount <= 55 ? 'recommended · full funnel' :
                                      'comprehensive · more tokens'}
                </span>
              </div>
              <div className="count-pills" role="radiogroup">
                {[10, 25, 50, 75].map((n) => (
                  <button
                    key={n}
                    role="radio"
                    aria-checked={eventCount === n}
                    onClick={() => setEventCount(n)}
                    disabled={scanning}
                    className={'count-pill' + (eventCount === n ? ' active' : '')}
                    title={`Generate ~${n} events`}
                  >
                    {n}
                  </button>
                ))}
                <div className="count-pill-custom">
                  <input
                    type="number"
                    min="10"
                    max="80"
                    step="5"
                    value={eventCount}
                    onChange={(e) => {
                      const v = Math.max(10, Math.min(80, parseInt(e.target.value, 10) || 50));
                      setEventCount(v);
                    }}
                    disabled={scanning}
                    aria-label="Custom event count"
                  />
                </div>
              </div>
            </div>

            {/* URL mode — big chat-style input */}
            {scanMode === 'url' && (
              <>
                <div className="input-shell">
                  <div className="input-row-hero">
                    <input
                      className="input-hero"
                      type="url"
                      placeholder="https://yourwebsite.com"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && !scanning && url.trim() && handleScan()}
                      disabled={scanning}
                      autoFocus
                    />
                    <button
                      className="send-btn"
                      onClick={handleScan}
                      disabled={scanning || !url.trim()}
                      aria-label="Analyse website"
                      title={scanning ? 'Working…' : 'Analyse website (Enter)'}
                    >
                      {scanning ? <span className="spinner" /> : '→'}
                    </button>
                  </div>
                </div>

                {/* Suggestion chips */}
                <div className="suggestions">
                  {[
                    { url: 'https://www.shopify.com',   label: 'shopify.com',   icon: '🛒' },
                    { url: 'https://www.airbnb.com',    label: 'airbnb.com',    icon: '🏠' },
                    { url: 'https://www.netflix.com',   label: 'netflix.com',   icon: '🎬' },
                    { url: 'https://www.duolingo.com',  label: 'duolingo.com',  icon: '📚' },
                  ].map((s) => (
                    <button
                      key={s.url}
                      className="suggestion"
                      onClick={() => { setUrl(s.url); setScanError(''); }}
                      disabled={scanning}
                    >
                      <span className="glyph">{s.icon}</span> Try {s.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* APK mode — drop zone */}
            {scanMode === 'apk' && (
              <div style={{ maxWidth: 720, margin: '0 auto' }}>
                <ApkUploadZone
                  onFileSelect={setApkFile}
                  selectedFile={apkFile}
                  scanning={scanning}
                />

                {/* Optional hints — improve classification for obfuscated /
                    indie / private APKs where manifest signals alone aren't
                    enough to identify the vertical. */}
                <div className="opt-hint-group">
                  <div className="opt-hint-label">
                    Optional — helps us classify obfuscated or private apps
                  </div>
                  <div className="opt-hint-shell">
                    <input
                      type="text"
                      className="opt-hint-input"
                      placeholder="App name (e.g. Zomato, Cafu, Acme Restaurant Booking)"
                      value={apkAppName}
                      onChange={(e) => setApkAppName(e.target.value)}
                      disabled={scanning}
                      maxLength={120}
                    />
                  </div>
                  <div className="opt-hint-shell">
                    <input
                      type="url"
                      className="opt-hint-input"
                      placeholder="Reference website URL (e.g. https://yourapp.com)"
                      value={apkRefUrl}
                      onChange={(e) => setApkRefUrl(e.target.value)}
                      disabled={scanning}
                      maxLength={300}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 18, display: 'flex', justifyContent: 'center' }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleApkScan}
                    disabled={scanning || !apkFile}
                    style={{ minWidth: 200 }}
                  >
                    {scanning ? <><span className="spinner" /> Analysing APK…</> : <>Analyse APK <span className="arrow-x">→</span></>}
                  </button>
                </div>

                {/* What we extract — feature grid */}
                <div className="feature-grid">
                  {[
                    { icon: '🖥', text: 'Screen & activity names' },
                    { icon: '🔑', text: 'Permissions → features' },
                    { icon: '🔗', text: 'Deep link schemes' },
                    { icon: '🧩', text: 'SDK integrations' },
                    { icon: '📦', text: 'Package & app name' },
                    { icon: '💬', text: 'UI string resources' },
                  ].map(({ icon, text }) => (
                    <div key={text} className="feature-cell">
                      <span className="ico">{icon}</span> {text}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Errors */}
            {scanError && (
              <div className="alert alert-error" style={{ marginTop: 22, textAlign: 'left', maxWidth: 720, marginLeft: 'auto', marginRight: 'auto' }}>
                ⚠ {scanError}
              </div>
            )}

            {/* Progress */}
            {scanning && (
              <div style={{ marginTop: 28, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto', textAlign: 'left' }}>
                {scanMode === 'url' ? (
                  <>
                    <div className="alert alert-info" style={{ marginBottom: 8 }}>🌐 Loading homepage, discovering internal links…</div>
                    <div className="alert alert-info" style={{ marginBottom: 8 }}>🔍 Crawling key pages (product, checkout, login, search…)</div>
                    <div className="alert alert-info">🤖 AI analysing full site and recommending events…</div>
                    <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 10, textAlign: 'center' }}>
                      Multi-page scan takes 30–60 seconds depending on site size.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="alert alert-info" style={{ marginBottom: 8 }}>📦 Opening APK binary and reading manifest…</div>
                    <div className="alert alert-info" style={{ marginBottom: 8 }}>🔍 Extracting screens, permissions, deep links, SDKs…</div>
                    <div className="alert alert-info">🤖 AI analysing app signals and generating mobile events…</div>
                    <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 10, textAlign: 'center' }}>
                      APK analysis typically takes 20–40 seconds.
                    </p>
                  </>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {/* ── Step 3: Results ── */}
      {step === 3 && result && (
        <>
          {/* Business context card */}
          <div className="card" style={{ borderColor: 'var(--border-hi)', background: '#13151c' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                    color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
                  }}>
                    Business Vertical
                  </span>
                  {/* Source badge */}
                  <span style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 4,
                    background: isApk ? 'rgba(167,139,250,0.15)' : 'rgba(59,130,246,0.15)',
                    color: isApk ? '#a78bfa' : '#3b82f6',
                    border: `1px solid ${isApk ? 'rgba(167,139,250,0.3)' : 'rgba(59,130,246,0.3)'}`,
                    fontFamily: 'var(--font-mono)', fontWeight: 700,
                  }}>
                    {isApk ? '📱 Android APK' : '🌐 Website'}
                  </span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
                  {result.businessVertical}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                  {result.websiteType}
                </div>
                {result.pageTypes?.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {result.pageTypes.map(pt => (
                      <span key={pt} style={{
                        fontSize: 10, padding: '2px 7px', borderRadius: 4,
                        background: 'var(--bg-input)', border: '1px solid var(--border)',
                        color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
                      }}>
                        {pt}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ flex: 2, minWidth: 260 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 8 }}>
                  {isApk ? 'App Summary' : 'Site Summary'}
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7 }}>
                  {result.businessDescription}
                </p>
              </div>

              <div style={{ flexShrink: 0 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, textAlign: 'center' }}>
                  {[
                    { n: result.scanSummary.mustHave,    label: 'Must Have',    color: '#22c55e' },
                    { n: result.scanSummary.recommended, label: 'Recommended',  color: '#3b82f6' },
                    { n: result.scanSummary.niceToHave,  label: 'Nice to Have', color: '#a78bfa' },
                    { n: result.scanSummary.totalEventsRecommended, label: 'Total Events', color: '#ff5533' },
                  ].map(({ n, label, color }) => (
                    <div key={label} style={{
                      background: 'var(--bg-input)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)', padding: '10px 14px',
                    }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>{n}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* APK meta panel */}
            {isApk && result.apkMeta && <ApkMetaPanel meta={result.apkMeta} />}

            {result.analyticsInsight && (
              <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 8 }}>
                  💡 Analytics Insight
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, fontStyle: 'italic' }}>
                  {result.analyticsInsight}
                </p>
              </div>
            )}
          </div>

          {/* Event list */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>
                Recommended Events
                <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text-2)' }}>
                  ({selected.size} selected)
                </span>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['all','must-have','recommended','nice-to-have'].map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: '5px 12px', borderRadius: 999, fontSize: 11,
                      fontFamily: 'var(--font-mono)', fontWeight: 700, cursor: 'pointer',
                      border: '1px solid var(--border)',
                      background: filterPriority === f ? 'var(--accent)' : 'var(--bg-input)',
                      color: filterPriority === f ? 'white' : 'var(--text-2)',
                    }}
                  >
                    {f === 'all' ? 'All' : PRIORITY_META[f]?.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" style={{ padding: '5px 12px', fontSize: 12 }} onClick={selectMust}>⚡ Select Must-Have</button>
              <button className="btn btn-ghost" style={{ padding: '5px 12px', fontSize: 12 }} onClick={selectAll}>Select All</button>
              <button className="btn btn-ghost" style={{ padding: '5px 12px', fontSize: 12 }} onClick={clearAll}>Clear</button>
            </div>

            {visibleEvents.length === 0 ? (
              <div className="no-events">No events in this filter.</div>
            ) : (
              visibleEvents.map(event => (
                <EventCard
                  key={event.eventName}
                  event={event}
                  selected={selected.has(event.eventName)}
                  onToggle={() => toggleEvent(event.eventName)}
                />
              ))
            )}
          </div>

          {/* Journey Builder panel */}
          <JourneyBuilderPanel
            useCase={journeyUseCase}
            onUseCaseChange={setJourneyUseCase}
            channels={journeyChannels}
            onChannelsChange={setJourneyChannels}
            loading={journeyLoading}
            error={journeyError}
            journeys={journeys}
            selectedCount={selected.size}
            onGenerate={handleGenerateJourneys}
          />

          {/* SDK Code block */}
          {selected.size > 0 && (
            <div className="card" style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>
                  CleverTap SDK Code
                  <span style={{ marginLeft: 10, fontWeight: 400, color: 'var(--text-2)', fontSize: 11 }}>
                    {selected.size} event{selected.size !== 1 ? 's' : ''} selected
                    {isApk && <span style={{ marginLeft: 8, color: '#a78bfa' }}>· Android / Kotlin / Java</span>}
                  </span>
                </div>
                <button className="btn btn-primary" style={{ padding: '8px 18px', fontSize: 13 }} onClick={copySDKCode}>
                  {copiedCode ? '✓ Copied!' : '📋 Copy Code'}
                </button>
              </div>

              {isApk && (
                <div className="alert alert-info" style={{ marginBottom: 14, fontSize: 12 }}>
                  💡 For Android, call <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>CleverTapAPI.getDefaultInstance(context).pushEvent("...", props)</code>
                </div>
              )}

              <pre style={{
                background: '#0d0f14', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: '20px',
                fontFamily: 'var(--font-mono)', fontSize: 12,
                lineHeight: 1.9, color: '#a8d8a8',
                overflowX: 'auto', whiteSpace: 'pre',
                maxHeight: 520, overflowY: 'auto',
              }}>
                {generateSDKCode(result.recommendedEvents.filter(e => selected.has(e.eventName)))}
              </pre>
            </div>
          )}

          {/* Bottom action row */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
            <button className="btn btn-ghost" onClick={() => { setStep(1); setResult(null); setApkFile(null); }}>
              ← Scan Another {isApk ? 'APK' : 'Site'}
            </button>
            <button
              className="btn btn-primary"
              onClick={downloadCSV}
              disabled={selected.size === 0}
            >
              ⬇ Download CSV ({selected.size} event{selected.size !== 1 ? 's' : ''})
            </button>
            <button
              className="btn btn-primary"
              onClick={handlePushToSheet}
              disabled={selected.size === 0 || sheetPushStatus === 'pushing'}
              style={{ background: sheetPushStatus === 'done' ? '#22c55e' : undefined }}
            >
              {sheetPushStatus === 'pushing' ? <><span className="spinner" /> Pushing…</> : '📤 Push to Google Sheet'}
            </button>
            {sheetPushStatus === 'done' && sheetUrl && (
              <a href={sheetUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
                Open Sheet ↗
              </a>
            )}
            {sheetPushStatus === 'error' && (
              <span style={{ color: '#ef4444', fontSize: 12, alignSelf: 'center' }}>Couldn't push — try again</span>
            )}
          </div>

          {/* Integration notes */}
          <div className="card" style={{ marginTop: 20, borderColor: 'rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.04)' }}>
            <div className="card-title" style={{ color: '#f59e0b' }}>📌 CleverTap Integration Notes</div>

            {result.recommendedEvents.some(e => /purchas|order|booking|payment|checkout|transaction|charged|buy/i.test(e.eventName)) && (
              <div style={{ marginBottom: 20, padding: '14px 16px', borderRadius: 'var(--radius)', background: 'rgba(255,85,51,0.08)', border: '1px solid rgba(255,85,51,0.25)' }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--accent)', marginBottom: 8 }}>
                  ⚡ Use the Special "Charged" Event for Purchases
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 10 }}>
                  CleverTap has a reserved event <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: 12 }}>Charged</code> for transactions.
                  It unlocks built-in revenue analytics, LTV, and repeat purchase tracking.
                </p>
                <pre style={{ background: '#0d0f14', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: '#a8d8a8', overflowX: 'auto', lineHeight: 1.8 }}>
{isApk
? `HashMap<String, Object> chargeDetails = new HashMap<>();
chargeDetails.put("Amount", 1299.00);
chargeDetails.put("Payment Mode", "UPI");
chargeDetails.put("Charged ID", "ORD-001");

ArrayList<HashMap<String, Object>> items = new ArrayList<>();
HashMap<String, Object> item = new HashMap<>();
item.put("Product Name", "Headphones");
item.put("Quantity", 1);
item.put("Price", 1299.00);
items.add(item);
chargeDetails.put("Items", items);

CleverTapAPI.getDefaultInstance(context).pushChargedEvent(chargeDetails, items);`
: `clevertap.event.push("Charged", {
  "Amount": 1299.00,
  "Payment Mode": "UPI",
  "Charged ID": "ORD-20240317-001",
  "Items": [{ "Product Name": "...", "Quantity": 1, "Price": 1299.00 }]
});`}
                </pre>
              </div>
            )}

            <CampaignSuggestions result={result} selected={selected} />

            <div style={{ marginBottom: 20, marginTop: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-1)', marginBottom: 10 }}>
                🤖 System Events — Auto-Tracked (No Code Needed)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
                {(isApk
                  ? [
                      { name: 'App Launched',       desc: 'Every cold/warm app open' },
                      { name: 'App Installed',       desc: 'First launch after install' },
                      { name: 'App Uninstalled',     desc: 'Tracked via silent push' },
                      { name: 'App Version Changed', desc: 'User updated the app' },
                      { name: 'Push Impressions',    desc: 'Push delivered to device' },
                      { name: 'Notification Clicked',desc: 'User taps a campaign message' },
                    ]
                  : [
                      { name: 'Web Session Started', desc: 'Web equivalent of App Launched' },
                      { name: 'UTM Visited',         desc: 'User arrives via UTM link' },
                      { name: 'Notification Sent',   desc: 'Campaign message dispatched' },
                      { name: 'Notification Viewed', desc: 'User sees in-app notification' },
                    ]
                ).map(ev => (
                  <div key={ev.name} style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border)' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: '#22c55e', marginBottom: 2 }}>{ev.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{ev.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding: '12px 16px', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Platform Limits
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                {[
                  { label: 'Custom event types', value: '512 max' },
                  { label: 'Properties per event', value: '256 max' },
                  { label: 'Items in Charged event', value: '256 max' },
                  { label: 'Property key length', value: '120 chars' },
                  { label: 'Property value length', value: '512 chars' },
                  { label: 'Value types', value: 'String, Integer, Float, Boolean, Date' },
                ].map(l => (
                  <div key={l.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{l.label}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>{l.value}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-3)' }}>
              📖 Full reference:{' '}
              <a href={isApk ? 'https://developer.clevertap.com/docs/android' : 'https://developer.clevertap.com/docs/events'}
                 target="_blank" rel="noopener noreferrer"
                 style={{ color: 'var(--blue)', textDecoration: 'none' }}>
                {isApk ? 'developer.clevertap.com/docs/android' : 'developer.clevertap.com/docs/events'}
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}