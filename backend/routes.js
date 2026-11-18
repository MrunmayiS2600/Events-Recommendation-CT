/**
 * routes.js
 * Centralises all Express route definitions for the CleverTap Integration Tool.
 * Now supports both website URL scanning and Android APK scanning.
 */

const express  = require('express');
const multer   = require('multer');
const os       = require('os');
const path     = require('path');
const fs       = require('fs');
const router   = express.Router();

const { scanWebsite }       = require('./scanner');
const { scanApk, extractApkSignals } = require('./apkscanner');
const { generateJourneys }           = require('./journeyBuilder');
const { store: trainingStore } = require('./training/store');
const { parseSheet }           = require('./training/sheetValidator');

// ─── Multer config — APK stored as temp file ─────────────────────────────────
// Limit defaults to 500 MB and is overridable via APK_MAX_SIZE_MB env var
// (set higher for game APKs, lower for resource-constrained deployments).
const APK_MAX_SIZE_MB    = Math.max(1, parseInt(process.env.APK_MAX_SIZE_MB || '500', 10));
const APK_MAX_SIZE_BYTES = APK_MAX_SIZE_MB * 1024 * 1024;
console.log(`[Routes] APK upload limit: ${APK_MAX_SIZE_MB} MB`);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename:    (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `apk_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: APK_MAX_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.apk') return cb(null, true);
    cb(new Error('Only .apk files are accepted.'));
  },
});



// ─── Multer config — training uploads (APK + event sheet) ────────────────────
// Accepts two fields in one multipart request: "apk" and "sheet".
// The sheet is written to a temp file alongside the APK; both are cleaned up
// after the handler runs. Sheets are tiny in practice (kilobytes), so the
// shared APK_MAX_SIZE_BYTES ceiling is more than enough.
const trainingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename:    (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const prefix = file.fieldname === 'sheet' ? 'sheet' : 'apk';
      cb(null, `${prefix}_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: APK_MAX_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'apk' && ext === '.apk') return cb(null, true);
    if (file.fieldname === 'sheet' && ['.csv', '.json', '.tsv', '.txt'].includes(ext)) return cb(null, true);
    cb(new Error(`Unexpected file "${file.originalname}" on field "${file.fieldname}".`));
  },
});

// ─── Trainer auth — passcode gate ────────────────────────────────────────────
// Trainer endpoints are protected by a shared passcode read from env.
// If TRAINER_PASSCODE is not set, all trainer endpoints are disabled — we
// deliberately do NOT default-allow, because that would expose corpus writes
// to anyone who can reach the API.
function requireTrainer(req, res, next) {
  const expected = process.env.TRAINER_PASSCODE;
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'Training is disabled. Set TRAINER_PASSCODE in the backend .env to enable trainer endpoints.',
    });
  }
  const provided = req.headers['x-trainer-passcode'] || req.query.trainer_passcode || (req.body && req.body.trainer_passcode);
  if (provided !== expected) {
    return res.status(401).json({ success: false, error: 'Invalid or missing trainer passcode.' });
  }
  next();
}
//sheet upload
const { pushEventsToSheet } = require('./googleSheets');

router.post('/push-to-sheet', async (req, res) => {
  const { events, isApk, appLabel, scannedUrl, vertical } = req.body;
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'No events provided' });
  }
  try {
    const result = await pushEventsToSheet({ events, isApk, appLabel, scannedUrl, vertical });
    res.json(result);
  } catch (err) {
    console.error('Sheets push failed:', err);
    res.status(502).json({ error: 'Failed to push to Google Sheets', detail: err.message });
  }
});


// ─── POST /api/scan ───────────────────────────────────────────────────────────
/**
 * Scans a given website URL with Puppeteer and returns AI-recommended events.
 * Body: { url: string }
 */
router.post('/scan', async (req, res) => {
  const { url, eventCount } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A valid "url" string is required.' });
  }

  const normalised = url.startsWith('http') ? url : `https://${url}`;
  const targetCount = Math.max(10, Math.min(80, parseInt(eventCount, 10) || 47));

  try {
    console.log(`[Scanner] Starting URL scan for: ${normalised} (n=${targetCount})`);
    const result = await scanWebsite(normalised, { targetCount });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Scanner] Error:', err.message);
    res.status(500).json({ error: `Scan failed: ${err.message}` });
  }
});

// ─── POST /api/scan-apk ───────────────────────────────────────────────────────
/**
 * Accepts an APK file upload, extracts signals from the binary,
 * and returns AI-recommended CleverTap events — same shape as /api/scan.
 *
 * Form data: file field named "apk"
 * Response:  { success, url, pageTitle, recommendedEvents, scanSummary, apkMeta, … }
 */
router.post('/scan-apk', upload.single('apk'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No APK file uploaded. Send as multipart/form-data with field name "apk".' });
  }

  const tempPath = req.file.path;
  // event_count may arrive as a multipart text field; parseInt + clamp.
  // Default 22 (not 50): asking for ~50 events forces the model to pad a
  // focused app with irrelevant permission/upload filler. A tighter target
  // yields a high-signal, in-vertical set. Callers can still request more.
  const targetCount = Math.max(10, Math.min(80, parseInt(req.body?.event_count ?? req.body?.eventCount, 10) || 22));

  // Optional caller-provided hints — the uploader almost always knows what the
  // app is, so just letting them type it eliminates guesswork. Both fields are
  // free-text; backend trims/length-caps inside scanApk.
  const appNameHint  = (req.body?.appName     || req.body?.app_name      || '').toString();
  const referenceUrl = (req.body?.referenceUrl || req.body?.reference_url || req.body?.url || '').toString();

  try {
    console.log(
      `[APK] Received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB) · n=${targetCount}` +
      (appNameHint  ? ` · appName="${appNameHint.slice(0, 60)}"` : '') +
      (referenceUrl ? ` · ref=${referenceUrl.slice(0, 80)}`      : '')
    );
    const result = await scanApk(tempPath, { targetCount, appNameHint, referenceUrl });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[APK] Error:', err.message);
    res.status(500).json({ error: `APK scan failed: ${err.message}` });
  } finally {
    // Clean up temp file
    fs.unlink(tempPath, () => {});
  }
});

// ─── POST /api/generate-journeys ─────────────────────────────────────────────
// Takes a user-typed use case + the events they've selected from a scan
// result, plus a list of approved channels, and returns two journey variants
// (Conservative + Aggressive) ready to be implemented in CleverTap journeys.
router.post('/generate-journeys', async (req, res) => {
  try {
    const {
      useCase,
      selectedEvents,
      vertical,
      businessDescription,
      channels,
    } = req.body || {};
    const result = await generateJourneys({
      useCase,
      selectedEvents,
      vertical,
      businessDescription,
      channels,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Journey] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── Training endpoints ──────────────────────────────────────────────────────
// All four endpoints are gated by the trainer passcode. They power the
// "organisation members upload (APK + event sheet) pairs over time" flow.
// Once the corpus has any above-threshold matches, /api/scan-apk will splice
// the neighbours into the LLM prompt automatically — these routes only manage
// the corpus itself.

// ─── POST /api/train ─────────────────────────────────────────────────────────
/**
 * Adds one (APK + event sheet) pair to the training corpus.
 *
 * Form data:
 *   - apk:                .apk file
 *   - sheet:              .csv or .json event sheet (canonical schema — see
 *                         training/sheetValidator.js)
 *   - app_name (optional): human label; falls back to detected app label
 *   - vertical (optional): one of the existing vertical IDs; used as retrieval
 *                          filter at query time
 *   - trainer_passcode:   required (also accepted as X-Trainer-Passcode header)
 */
router.post(
  '/train',
  requireTrainer,
  trainingUpload.fields([
    { name: 'apk',   maxCount: 1 },
    { name: 'sheet', maxCount: 1 },
  ]),
  async (req, res) => {
    const apkFile   = req.files?.apk?.[0];
    const sheetFile = req.files?.sheet?.[0];

    if (!apkFile || !sheetFile) {
      // Clean whichever file did make it through before bailing.
      if (apkFile)   fs.unlink(apkFile.path,   () => {});
      if (sheetFile) fs.unlink(sheetFile.path, () => {});
      return res.status(400).json({
        success: false,
        error: 'Both "apk" and "sheet" multipart fields are required.',
      });
    }

    const cleanup = () => {
      fs.unlink(apkFile.path,   () => {});
      fs.unlink(sheetFile.path, () => {});
    };

    try {
      console.log(`[Train] APK: ${apkFile.originalname} (${(apkFile.size / 1024 / 1024).toFixed(1)} MB)`);
      console.log(`[Train] Sheet: ${sheetFile.originalname} (${sheetFile.size} bytes)`);

      // 1. Validate the event sheet first — fastest path to failure.
      const sheetBuffer = fs.readFileSync(sheetFile.path);
      const { events, errors: sheetErrors } = parseSheet({
        buffer: sheetBuffer,
        originalname: sheetFile.originalname,
      });

      // 2. Extract signals from the APK (same parser the live scan uses).
      const signals = await extractApkSignals(apkFile.path);

      // 3. Add to corpus.
      const entry = trainingStore.add({
        signals,
        events,
        vertical: req.body?.vertical,
        appName:  req.body?.app_name,
        fileName: apkFile.originalname,
      });

      res.json({
        success: true,
        entry,
        sheetWarnings: sheetErrors,          // non-fatal row-level errors
        corpusSize:    trainingStore.stats().totalEntries,
      });
    } catch (err) {
      console.error('[Train] Error:', err.message);
      res.status(400).json({ success: false, error: err.message });
    } finally {
      cleanup();
    }
  }
);

// ─── GET /api/training ───────────────────────────────────────────────────────
router.get('/training', requireTrainer, (req, res) => {
  res.json({ success: true, entries: trainingStore.list() });
});

// ─── GET /api/training/stats ─────────────────────────────────────────────────
router.get('/training/stats', requireTrainer, (req, res) => {
  res.json({ success: true, stats: trainingStore.stats() });
});

// ─── GET /api/training/:id ───────────────────────────────────────────────────
router.get('/training/:id', requireTrainer, (req, res) => {
  const entry = trainingStore.get(req.params.id);
  if (!entry) return res.status(404).json({ success: false, error: 'Entry not found' });
  res.json({ success: true, entry });
});

// ─── DELETE /api/training/:id ────────────────────────────────────────────────
router.delete('/training/:id', requireTrainer, (req, res) => {
  const ok = trainingStore.delete(req.params.id);
  if (!ok) return res.status(404).json({ success: false, error: 'Entry not found' });
  res.json({ success: true, corpusSize: trainingStore.stats().totalEntries });
});

// ─── Multer error handler ─────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `APK file too large. Maximum size is ${APK_MAX_SIZE_MB} MB.` });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err && err.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;