/**
 * journeyBuilder.js — generates CleverTap journey variants from a user
 * use case + selected events.
 *
 * Takes: use case (free text), the events the user has already selected
 * from the scan result, the detected vertical, business description, and
 * a list of channels the user wants to use (push / email / in-app / SMS /
 * WhatsApp / web).
 *
 * Returns: TWO journey variants — a Conservative one (low-friction,
 * 1-2 touchpoints) and an Aggressive one (multi-channel, higher frequency).
 * Each variant has: name, description, goal, channels, structured steps
 * (trigger / wait / send / branch), KPIs, success metric.
 *
 * Same LLM router as scanner.js / apkscanner.js — Groq → Gemini → OpenAI
 * by env-var presence.
 */

'use strict';

const https = require('https');

const SUPPORTED_CHANNELS = ['push', 'email', 'in-app', 'sms', 'whatsapp', 'web'];

function httpsPost({ hostname, path: urlPath, headers, body, timeout = 90000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: urlPath, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Journey AI request timed out')); });
    req.write(body);
    req.end();
  });
}

async function callAI(prompt, maxTokens = 3500) {
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-04-17';
    const raw = await httpsPost({
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      headers:  { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.5 },
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Gemini error: ${parsed.error.message}`);
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  if (process.env.GROQ_API_KEY) {
    const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
    const safeCeiling = parseInt(process.env.GROQ_MAX_TOKENS || '5000', 10);
    const raw = await httpsPost({
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      headers:  { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        max_tokens:  Math.min(safeCeiling, maxTokens),
        temperature: 0.5,
        ...((process.env.GROQ_MODEL || 'openai/gpt-oss-120b').includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        messages:    [{ role: 'user', content: prompt }],
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Groq error: ${parsed.error.message}`);
    return parsed.choices?.[0]?.message?.content || '';
  }
  if (process.env.OPENAI_API_KEY) {
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const raw = await httpsPost({
      hostname: 'api.openai.com',
      path:     '/v1/chat/completions',
      headers:  { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        max_tokens:  maxTokens,
        temperature: 0.5,
        messages:    [{ role: 'user', content: prompt }],
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`OpenAI error: ${parsed.error.message}`);
    return parsed.choices?.[0]?.message?.content || '';
  }
  throw new Error('No AI provider configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY.');
}

function buildJourneyPrompt({ useCase, selectedEvents, vertical, businessDescription, channels }) {
  const compactEvents = selectedEvents.slice(0, 30).map((e) => ({
    name:       e.eventName,
    category:   e.category,
    priority:   e.priority,
    trigger:    e.triggerDescription,
    properties: (e.suggestedProperties || []).slice(0, 6),
  }));

  return `You are a senior CleverTap journeys / marketing-automation architect. The user wants TWO journey variants for a specific use case, built from the events they have selected for their app.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
APP CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Vertical:     ${vertical || 'unknown'}
Description:  ${businessDescription || 'not provided'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USER USE CASE — what they want this journey to achieve
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${useCase}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EVENTS THE USER HAS SELECTED (use these as triggers / branches / completion criteria)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${JSON.stringify(compactEvents, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
APPROVED CHANNELS (do not invent channels outside this list)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${channels.join(', ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCTIONS — produce exactly TWO variants
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Variant 1 — "Conservative":
   • Low-friction: 1-3 message touchpoints total.
   • Prefer 1-2 channels (typically email + one secondary).
   • Longer waits between sends.
   • Goal: nudge without fatigue.

Variant 2 — "Aggressive":
   • Higher frequency: 3-6 touchpoints.
   • Use 3+ channels including push and in-app for immediacy.
   • Shorter waits + branching based on event firing.
   • Goal: maximise conversion within the active window.

For each variant produce these fields:
   • name              — short variant name ("Conservative — Email-led", "Aggressive — Multi-channel push + email")
   • description       — 1 sentence summarising the strategy
   • goal              — what success looks like (1 sentence)
   • channels          — array of channel ids used in this variant (subset of approved list)
   • steps             — ORDERED array of journey steps. Step types:
        { "type": "trigger",  "event": "<event name from the selected list>",
          "description": "User does X" }
        { "type": "wait",     "duration": "15 minutes" | "2 hours" | "1 day" | "3 days",
          "condition": "if 'Event Name' not fired" (optional, defaults to unconditional) }
        { "type": "send",     "channel": "push|email|in-app|sms|whatsapp|web",
          "title": "<short subject/title>",
          "body":  "<one-line message — keep under 140 chars>",
          "cta":   "<button label>" }
        { "type": "branch",   "condition": "if 'Event Name' fired" | "if 'Event Name' not fired",
          "yes": [ ...nested steps... ],
          "no":  [ ...nested steps... ] }
   • kpis              — array of KPI names this variant should be measured on (e.g. ["Open rate", "Conversion rate", "Time to convert"])
   • successMetric     — concrete success criterion in plain English ("Track 'Order Placed' fired within 48 hours of trigger")

HARD RULES:
1. Every "event" field must EXACTLY match an event name from the selected events above.
2. Every "channel" field must come from the approved channels list.
3. Variants must be visibly different — not just renamed copies.
4. Keep body copy specific to the vertical (don't say "Welcome back!" if the vertical is rideshare; say "Your ride awaits — book in one tap").
5. Return ONLY valid JSON in the EXACT shape below — no markdown, no surrounding prose, no code fences.

OUTPUT SHAPE (return this and only this):
{
  "useCase": "${useCase.replace(/"/g, '\\"')}",
  "variants": [
    {
      "id": "conservative",
      "name": "...",
      "description": "...",
      "goal": "...",
      "channels": ["..."],
      "steps": [ ... ],
      "kpis": ["..."],
      "successMetric": "..."
    },
    {
      "id": "aggressive",
      "name": "...",
      "description": "...",
      "goal": "...",
      "channels": ["..."],
      "steps": [ ... ],
      "kpis": ["..."],
      "successMetric": "..."
    }
  ]
}
`;
}

function parseJourneyResponse(raw) {
  // Strip markdown fences / preamble — LLMs sometimes wrap JSON
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Find first { … last } in case there's stray text
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('Journey AI response did not contain a JSON object');
  }
  s = s.slice(first, last + 1);
  let parsed;
  try { parsed = JSON.parse(s); }
  catch (err) { throw new Error(`Journey AI returned invalid JSON: ${err.message}`); }
  if (!parsed || !Array.isArray(parsed.variants) || parsed.variants.length === 0) {
    throw new Error('Journey AI response missing "variants" array');
  }
  // Light shape validation — ensure required fields exist on each variant
  parsed.variants = parsed.variants.map((v, i) => ({
    id:            v.id || (i === 0 ? 'conservative' : 'aggressive'),
    name:          v.name || `Variant ${i + 1}`,
    description:   v.description || '',
    goal:          v.goal || '',
    channels:      Array.isArray(v.channels) ? v.channels : [],
    steps:         Array.isArray(v.steps) ? v.steps : [],
    kpis:          Array.isArray(v.kpis) ? v.kpis : [],
    successMetric: v.successMetric || '',
  }));
  return parsed;
}

async function generateJourneys({ useCase, selectedEvents, vertical, businessDescription, channels }) {
  if (!useCase || typeof useCase !== 'string' || useCase.trim().length < 4) {
    throw new Error('useCase is required (min 4 chars)');
  }
  if (!Array.isArray(selectedEvents) || selectedEvents.length === 0) {
    throw new Error('At least one selected event is required');
  }
  const validChannels = (channels || []).filter((c) => SUPPORTED_CHANNELS.includes(c));
  if (validChannels.length === 0) {
    throw new Error(`At least one channel from [${SUPPORTED_CHANNELS.join(', ')}] is required`);
  }

  console.log(
    `[Journey] use case="${useCase.slice(0, 60)}..." | ` +
    `events=${selectedEvents.length} | channels=${validChannels.join(',')} | vertical=${vertical || 'unknown'}`
  );

  const prompt = buildJourneyPrompt({
    useCase:             useCase.trim(),
    selectedEvents,
    vertical,
    businessDescription,
    channels:            validChannels,
  });

  const raw = await callAI(prompt, 4500);
  const parsed = parseJourneyResponse(raw);
  console.log(`[Journey] ✓ generated ${parsed.variants.length} variants`);
  return parsed;
}

module.exports = { generateJourneys, SUPPORTED_CHANNELS };
