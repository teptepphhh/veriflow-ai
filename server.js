// server.js - main Express file: middleware, API routes, and the dashboard.

require('dotenv').config(); // load .env first so process.env is ready

const express = require('express');
const path = require('path');

const { validatePayload, ORDER_SCHEMA, ITEM_SCHEMA } = require('./validators/schemaValidator');
const { triageDrift } = require('./services/aiTriageService');
const { sendDriftAlert } = require('./services/webhookService');
const { readLogs, appendLog, clearLogs } = require('./storage/logStore');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'veriflow-local-key';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serves the dashboard

// Checks the x-api-key header. Only used on routes that change data.
function requireApiKey(req, res, next) {
  if (req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key header.' });
  }
  next();
}

// POST /api/validate
// Flow: validate -> if drift, AI triage + webhook alert -> save log
app.post('/api/validate', requireApiKey, async (req, res) => {
  try {
    const payload = req.body;

    // 1. Check the payload against the contract
    const { status, issues } = validatePayload(payload);

    // 2. Triage and alert are only needed when there is drift
    let triage = null;
    let webhook = null;
    if (status === 'DRIFT_DETECTED') {
      triage = await triageDrift(payload, issues);
      webhook = await sendDriftAlert({ issues, triage });
    }

    // 3. Save every result (valid or not) as an audit log
    const log = appendLog({ status, payload, issues, triage, webhookSent: webhook ? webhook.sent : false });

    res.json(log);
  } catch (err) {
    console.error('[validate] Unexpected error:', err);
    res.status(500).json({ error: 'Internal error while validating payload.' });
  }
});

// GET /api/health - quick check that the server is running.
// Only shows whether Gemini/webhook are set up, never the actual keys.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    logCount: readLogs().length,
    gemini: (process.env.GEMINI_API_KEY || '').trim() ? 'configured' : 'not configured (rule-based fallback)',
    webhook: (process.env.WEBHOOK_URL || '').trim() ? 'configured' : 'not configured (alerts skipped)',
  });
});

// GET /api/schema - sends the contract to the dashboard, so the
// "expected contract" panel always matches the validator.
app.get('/api/schema', (req, res) => {
  res.json({ order: ORDER_SCHEMA, item: ITEM_SCHEMA });
});

// GET /api/logs - read only, so no API key needed
app.get('/api/logs', (req, res) => {
  res.json(readLogs());
});

// DELETE /api/logs - deletes data, so it needs the API key
app.delete('/api/logs', requireApiKey, (req, res) => {
  clearLogs();
  res.json({ cleared: true });
});

// Error handler. Bad JSON in the request body ends up here,
// and we return a 400 instead of crashing.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body: ' + err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

// Only start listening when run with "npm start". The tests import the app
// without this, and start their own server on a random port.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Veriflow running at http://localhost:${PORT}`);
  });
}

module.exports = app;
