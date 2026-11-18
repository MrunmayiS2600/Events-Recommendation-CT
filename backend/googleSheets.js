const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.SHARED_SECRET;


async function pushEventsToSheet({ events, isApk, appLabel, scannedUrl, vertical }) {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
    throw new Error('Google Sheets export is not configured. Set APPS_SCRIPT_URL and SHARED_SECRET in backend/.env.');
  }
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: APPS_SCRIPT_SECRET,
      events,
      sourceLabel: appLabel,
      scannedUrl,
      vertical,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.detail || data.error);
  return data;
}

module.exports = { pushEventsToSheet };