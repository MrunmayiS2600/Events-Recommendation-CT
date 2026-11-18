/**
 * CampaignSuggestions.jsx  –  AI-powered campaign strategy panel
 *
 * Calls /api/campaigns with the scan result + selected events.
 * The backend (campaignGenerator.js) uses AI to generate campaigns that are:
 *   • Specific to the scanned website and business vertical
 *   • Channel-aware: no Push/In-App for web-only sites
 *   • Triggered by the actual selected events
 *
 * Props:
 *   result   – full scan result object from /api/scan
 *   selected – Set<string> of selected event names
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';

const API = process.env.REACT_APP_API_URL ? `${process.env.REACT_APP_API_URL}/api` : '/api';

// ─── Channel visual metadata ──────────────────────────────────────────────────
const CHANNEL_META = {
  'Email':                 { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.28)',  icon: '✉️',  label: 'Email' },
  'SMS':                   { color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.28)',   icon: '💬',  label: 'SMS' },
  'Web Push Notification': { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.28)', icon: '🔔',  label: 'Web Push' },
  'Web Pop-up / Banner':   { color: '#a78bfa', bg: 'rgba(167,139,250,0.12)',border: 'rgba(167,139,250,0.28)',icon: '💭',  label: 'Web Pop-up' },
  'WhatsApp':              { color: '#25d366', bg: 'rgba(37,211,102,0.12)', border: 'rgba(37,211,102,0.28)', icon: '📲',  label: 'WhatsApp' },
  'Push Notification':     { color: '#f97316', bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.28)', icon: '📳',  label: 'Push' },
  'In-App Message':        { color: '#e879f9', bg: 'rgba(232,121,249,0.12)',border: 'rgba(232,121,249,0.28)',icon: '📱',  label: 'In-App' },
};

function getChannelMeta(channel) {
  return CHANNEL_META[channel] || {
    color: '#9aa0ae', bg: 'rgba(154,160,174,0.12)',
    border: 'rgba(154,160,174,0.28)', icon: '📡', label: channel,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ChannelPill({ channel }) {
  const m = getChannelMeta(channel);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 999,
      fontSize: 11, fontWeight: 700, letterSpacing: '0.03em',
      background: m.bg, border: `1px solid ${m.border}`, color: m.color,
      fontFamily: 'var(--font-mono)',
    }}>
      {m.icon} {m.label}
    </span>
  );
}

function StepRow({ step, index, accentColor }) {
  return (
    <div style={{
      display: 'flex', gap: 14, alignItems: 'flex-start',
      padding: '12px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      {/* Step circle */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, paddingTop: 2 }}>
        <div style={{
          width: 26, height: 26, borderRadius: '50%',
          background: `${accentColor}18`, border: `2px solid ${accentColor}45`,
          display: 'grid', placeItems: 'center',
          fontSize: 10, fontWeight: 800, color: accentColor,
          fontFamily: 'var(--font-mono)',
        }}>
          {index + 1}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Delay + channel */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 7, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 11, fontWeight: 700, color: 'var(--text-3)',
            fontFamily: 'var(--font-mono)', letterSpacing: '0.05em',
            background: 'var(--bg-input)', border: '1px solid var(--border)',
            padding: '2px 9px', borderRadius: 5,
          }}>
            ⏱ {step.delay}
          </span>
          <ChannelPill channel={step.channel} />
        </div>
        {/* Message copy */}
        <p style={{
          fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7,
          margin: 0, fontStyle: 'italic',
          padding: '8px 12px',
          background: 'var(--bg-input)',
          borderRadius: 6,
          border: '1px solid var(--border)',
          borderLeft: `3px solid ${accentColor}50`,
        }}>
          "{step.message}"
        </p>
      </div>
    </div>
  );
}

function CampaignCard({ campaign, index }) {
  const [expanded, setExpanded] = useState(index === 0);
  const accent = campaign.accentColor || '#ff5533';

  return (
    <div style={{
      border: `1px solid ${expanded ? accent + '40' : 'var(--border)'}`,
      borderRadius: 'var(--radius)',
      background: expanded ? `${accent}05` : 'var(--bg-input)',
      marginBottom: 12,
      transition: 'all 0.2s',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '16px 18px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        {/* Icon */}
        <div style={{
          width: 42, height: 42, borderRadius: 11, flexShrink: 0,
          background: `${accent}18`, border: `1px solid ${accent}35`,
          display: 'grid', placeItems: 'center', fontSize: 20,
        }}>
          {campaign.icon}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>
              {campaign.name}
            </span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {(campaign.channels || []).map(c => <ChannelPill key={c} channel={c} />)}
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, lineHeight: 1.55 }}>
            {campaign.goal}
          </p>
        </div>

        <span style={{
          color: 'var(--text-3)', fontSize: 18, flexShrink: 0,
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.2s',
        }}>
          ⌄
        </span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: '0 18px 18px 18px', borderTop: `1px solid ${accent}20` }}>

          {/* Trigger */}
          <div style={{ paddingTop: 16, marginBottom: 18 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 16px', borderRadius: 8,
              background: `${accent}10`, border: `1px solid ${accent}30`,
            }}>
              <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>⚡</span>
              <div>
                <div style={{
                  fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: accent,
                  fontFamily: 'var(--font-mono)', marginBottom: 4,
                }}>
                  Campaign Trigger
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-1)', fontWeight: 600, lineHeight: 1.5 }}>
                  {campaign.trigger}
                </div>
              </div>
            </div>
          </div>

          {/* Message sequence */}
          <div style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase',
            color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 4,
          }}>
            Message Sequence
          </div>
          <div style={{ marginBottom: 16 }}>
            {(campaign.steps || []).map((step, i) => (
              <StepRow key={i} step={step} index={i} accentColor={accent} />
            ))}
          </div>

          {/* Segment + KPI */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 10, marginTop: 4,
          }}>
            <div style={{
              padding: '11px 14px', borderRadius: 8,
              background: 'var(--bg-input)', border: '1px solid var(--border)',
            }}>
              <div style={{
                fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'var(--text-3)',
                fontFamily: 'var(--font-mono)', marginBottom: 6,
              }}>
                🎯 Target Segment
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.65, margin: 0 }}>
                {campaign.segmentHint}
              </p>
            </div>

            <div style={{
              padding: '11px 14px', borderRadius: 8,
              background: 'var(--bg-input)', border: '1px solid var(--border)',
            }}>
              <div style={{
                fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'var(--text-3)',
                fontFamily: 'var(--font-mono)', marginBottom: 6,
              }}>
                📊 KPIs to Track
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.65, margin: 0 }}>
                {campaign.kpi}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────
function CampaignSkeleton() {
  return (
    <div>
      {[1, 2, 3].map(i => (
        <div key={i} style={{
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          background: 'var(--bg-input)', marginBottom: 12, padding: '16px 18px',
          display: 'flex', gap: 14, alignItems: 'center',
          animation: 'pulse 1.6s ease-in-out infinite',
        }}>
          <div style={{
            width: 42, height: 42, borderRadius: 11, flexShrink: 0,
            background: 'var(--border)',
          }} />
          <div style={{ flex: 1 }}>
            <div style={{ height: 14, borderRadius: 6, background: 'var(--border)', marginBottom: 8, width: '45%' }} />
            <div style={{ height: 11, borderRadius: 6, background: 'var(--border)', width: '75%' }} />
          </div>
        </div>
      ))}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      `}</style>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function CampaignSuggestions({ result, selected }) {
  const [campaigns, setCampaigns] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [generated, setGenerated] = useState(false);   // has at least one fetch succeeded?
  const lastFetchKey = useRef('');                      // debounce guard

  // Build a stable "key" from result + selected so we only re-fetch when they change
  const fetchKey = [
    result?.url || '',
    [...(selected || [])].sort().join(','),
  ].join('|');

  const fetchCampaigns = useCallback(async (key) => {
    if (!result?.recommendedEvents || !selected || selected.size === 0) return;

    // Guard: don't re-fetch if nothing changed
    if (key === lastFetchKey.current) return;
    lastFetchKey.current = key;

    const selectedEvents = result.recommendedEvents.filter(e => selected.has(e.eventName));
    if (selectedEvents.length === 0) return;

    setLoading(true);
    setError('');

    try {
      const res  = await fetch(`${API}/campaigns`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ scanResult: result, selectedEvents }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Campaign generation failed');
      setCampaigns(data.campaigns || []);
      setGenerated(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [result, selected]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch on mount (when result first arrives) — not on every selection change
  useEffect(() => {
    if (result && selected?.size > 0 && !generated && !loading) {
      fetchCampaigns(fetchKey);
    }
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!result) return null;

  // ── Detect platform for the channel legend ──
  const haystack = [
    result.websiteType || '', result.businessDescription || '',
  ].join(' ').toLowerCase();
  const hasMobileApp = ['mobile app','ios app','android app','app store','play store','download app'].some(s => haystack.includes(s));
  const visibleChannels = hasMobileApp
    ? ['Email','SMS','Web Push Notification','Web Pop-up / Banner','WhatsApp','Push Notification','In-App Message']
    : ['Email','SMS','Web Push Notification','Web Pop-up / Banner','WhatsApp'];

  return (
    <div style={{
      marginTop: 24,
      border: '1px solid rgba(255,85,51,0.22)',
      borderRadius: 'var(--radius)',
      background: 'rgba(255,85,51,0.02)',
      padding: '20px 20px 16px',
    }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 14,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title" style={{ marginBottom: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
            🎯 Starter Campaign Playbook
            {/* Platform badge */}
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 4,
              background: hasMobileApp ? 'rgba(167,139,250,0.15)' : 'rgba(59,130,246,0.15)',
              color: hasMobileApp ? '#a78bfa' : '#3b82f6',
              border: `1px solid ${hasMobileApp ? 'rgba(167,139,250,0.3)' : 'rgba(59,130,246,0.3)'}`,
              fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.04em',
            }}>
              {hasMobileApp ? '📱 Web + App' : '🌐 Web Only'}
            </span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, margin: 0 }}>
            {generated && campaigns.length > 0
              ? <>AI-generated <strong style={{ color: 'var(--text-1)' }}>{campaigns.length} campaign strategies</strong> tailored for <em>{result.businessVertical}</em>, based on your {selected.size} selected event{selected.size !== 1 ? 's' : ''}.</>
              : loading
                ? <>Analysing your selected events and generating campaign strategies…</>
                : <>Click <strong style={{ color: 'var(--text-1)' }}>Generate Campaigns</strong> to get AI-tailored strategies based on your selected events.</>
            }
          </p>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
          {generated && !loading && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', borderRadius: 999,
              background: 'rgba(255,85,51,0.12)', border: '1px solid rgba(255,85,51,0.3)',
              fontSize: 11, fontWeight: 700, color: '#ff5533',
              fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
            }}>
              ⚡ {campaigns.length} campaigns
            </span>
          )}
          <button
            onClick={() => {
              lastFetchKey.current = ''; // force re-fetch
              fetchCampaigns(fetchKey + '_manual_' + Date.now());
            }}
            disabled={loading || selected.size === 0}
            style={{
              padding: '8px 16px', borderRadius: 'var(--radius)',
              background: loading ? 'var(--bg-input)' : 'var(--accent)',
              color: loading ? 'var(--text-3)' : 'white',
              border: `1px solid ${loading ? 'var(--border)' : 'var(--accent)'}`,
              cursor: loading || selected.size === 0 ? 'not-allowed' : 'pointer',
              fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)',
              display: 'flex', alignItems: 'center', gap: 7,
              transition: 'all 0.15s',
              opacity: selected.size === 0 ? 0.5 : 1,
            }}
          >
            {loading
              ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Generating…</>
              : generated
                ? '↺ Regenerate'
                : '✦ Generate Campaigns'}
          </button>
        </div>
      </div>

      {/* ── Channel legend ── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
        padding: '9px 14px', borderRadius: 8,
        background: 'var(--bg-input)', border: '1px solid var(--border)',
        marginBottom: 20,
      }}>
        <span style={{
          fontSize: 10, color: 'var(--text-3)', fontWeight: 800,
          fontFamily: 'var(--font-mono)', letterSpacing: '0.07em',
          textTransform: 'uppercase', marginRight: 2,
        }}>
          Channels:
        </span>
        {visibleChannels.map(c => {
          const m = getChannelMeta(c);
          return (
            <span key={c} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 11, color: m.color, fontWeight: 600,
            }}>
              {m.icon} {m.label}
            </span>
          );
        })}
        {!hasMobileApp && (
          <span style={{
            marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)',
            fontStyle: 'italic', fontFamily: 'var(--font-mono)',
          }}>
            Push & In-App excluded (web-only site)
          </span>
        )}
      </div>

      {/* ── States ── */}

      {/* Empty / not yet generated */}
      {!loading && !generated && !error && (
        <div style={{
          textAlign: 'center', padding: '40px 20px',
          color: 'var(--text-3)', fontSize: 13,
        }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🤖</div>
          <div style={{ fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
            Ready to generate campaigns
          </div>
          <div style={{ fontSize: 12 }}>
            Select events above, then click "Generate Campaigns" to get AI-tailored strategies.
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && <CampaignSkeleton />}

      {/* Error */}
      {error && !loading && (
        <div style={{
          padding: '14px 18px', borderRadius: 8,
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
          color: '#f87171', fontSize: 13, display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>❌</span>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>Campaign generation failed</div>
            <div style={{ opacity: 0.8 }}>{error}</div>
          </div>
        </div>
      )}

      {/* Campaign cards */}
      {!loading && generated && campaigns.length > 0 && (
        <div>
          {campaigns.map((c, i) => (
            <CampaignCard key={`${c.name}-${i}`} campaign={c} index={i} />
          ))}
        </div>
      )}

      {/* Footer */}
      {generated && campaigns.length > 0 && !loading && (
        <div style={{
          marginTop: 16, paddingTop: 14,
          borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>💡</span>
          <p style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, margin: 0 }}>
            Personalise message copy with user attributes using CleverTap's{' '}
            <strong style={{ color: 'var(--text-2)' }}>Liquid Tags</strong>.
            Build multi-step sequences in{' '}
            <em>CleverTap Dashboard → Campaigns → Journeys</em>.
            Full reference:{' '}
            <a
              href="https://developer.clevertap.com/docs/journeys"
              target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--blue, #3b82f6)', textDecoration: 'none' }}
            >
              developer.clevertap.com/docs/journeys
            </a>
          </p>
        </div>
      )}
    </div>
  );
}