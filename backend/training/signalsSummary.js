'use strict';

/**
 * signalsSummary.js
 *
 * Turns the raw signal object emitted by extractApkSignals() (and the
 * equivalent website scanner output) into a single canonical text blob.
 *
 * That blob is what the retrieval layer indexes — both the corpus entries and
 * the live query for a client APK go through this same function, so the two
 * sides match against the same vocabulary.
 *
 * Caps each list so a single huge APK doesn't dominate the index.
 */

const CAPS = {
  permissions:    40,
  sdks:           25,
  screenNames:    60,
  activities:     50,
  featureHints:   40,
  uiStrings:    120,
  deepLinks:      20,
  inferredFeatures: 30,
};

function clip(arr, n) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, n).map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Build the canonical summary text for an APK signal object.
 * Sections are line-prefixed so the index can weight matches by section later.
 */
function summariseApkSignals(signals) {
  const lines = [];

  if (signals.appLabel)    lines.push(`app: ${signals.appLabel}`);
  if (signals.packageName) lines.push(`package: ${signals.packageName}`);

  const perms = clip(signals.permissions, CAPS.permissions);
  if (perms.length) lines.push(`permissions: ${perms.join(', ')}`);

  const sdks = clip(signals.sdks, CAPS.sdks);
  if (sdks.length) lines.push(`sdks: ${sdks.join(', ')}`);

  const screens = clip(signals.screenNames, CAPS.screenNames);
  if (screens.length) lines.push(`screens: ${screens.join(', ')}`);

  const activities = clip(signals.activities, CAPS.activities);
  if (activities.length) lines.push(`activities: ${activities.join(', ')}`);

  const features = clip(signals.featureHints, CAPS.featureHints);
  if (features.length) lines.push(`features: ${features.join(', ')}`);

  const inferred = clip(signals.inferredFeatures, CAPS.inferredFeatures);
  if (inferred.length) lines.push(`inferred: ${inferred.join(', ')}`);

  const ui = clip(signals.uiStrings, CAPS.uiStrings);
  if (ui.length) lines.push(`ui_strings: ${ui.join(', ')}`);

  const deepLinks = clip(signals.deepLinkSchemes, CAPS.deepLinks);
  if (deepLinks.length) lines.push(`deep_links: ${deepLinks.join(', ')}`);

  return lines.join('\n');
}

/**
 * Tokeniser shared between corpus indexing and query scoring.
 * Lowercase, split on non-alphanumeric, drop tokens shorter than 2 chars,
 * de-duplicate trivial English stopwords to keep BM25 honest.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with',
]);

function tokenise(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length >= 2 && !STOPWORDS.has(t));
}

module.exports = {
  summariseApkSignals,
  tokenise,
};
