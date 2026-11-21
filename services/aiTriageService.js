// services/aiTriageService.js
// Explains why a payload drifted and suggests a fix.
// Uses Gemini when there is an API key. If the key is missing or the call
// fails, it uses a rule-based explanation instead, so the app never breaks.

// The model name can be changed with GEMINI_MODEL in .env.
// (Google retires old models, so this avoids editing code when that happens.)
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

function getModel() {
  return (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;
}

// How long we wait for Gemini (default 20 seconds). Can be changed in .env.
function getTimeoutMs() {
  const value = Number(process.env.GEMINI_TIMEOUT_MS);
  return value > 0 ? value : 20000;
}

// Pause before the one retry (default 1 second). The tests set this to 0.
function getRetryDelayMs() {
  const raw = process.env.GEMINI_RETRY_DELAY_MS;
  if (raw === undefined || raw === '') return 1000;
  const value = Number(raw);
  return value >= 0 ? value : 1000;
}

// Fallback: builds the explanation from the issue list, no AI needed.
function ruleBasedTriage(issues) {
  const missing = issues.filter((i) => i.type === 'MISSING_FIELD');
  const wrongType = issues.filter((i) => i.type === 'WRONG_TYPE');
  const unexpected = issues.filter((i) => i.type === 'UNEXPECTED_FIELD');
  const invalid = issues.filter((i) => i.type === 'INVALID_VALUE');

  const causes = [];
  const fixes = [];

  // Missing + unexpected fields together usually means a field was renamed
  if (missing.length && unexpected.length) {
    causes.push(
      `Possible field rename: missing [${missing.map((i) => i.field).join(', ')}] while new fields [${unexpected.map((i) => i.field).join(', ')}] appeared.`
    );
    fixes.push('Confirm the rename with the API producer, then update the sender (or the contract) so both sides use the same field names.');
  } else if (missing.length) {
    causes.push(`Required fields are missing: ${missing.map((i) => i.field).join(', ')}.`);
    fixes.push('Make the sender include all required fields, or mark them optional in the contract if that is intended.');
  } else if (unexpected.length) {
    causes.push(`Unexpected fields were sent: ${unexpected.map((i) => i.field).join(', ')}.`);
    fixes.push('Remove the extra fields from the sender, or add them to the contract if the API change is intentional.');
  }

  if (wrongType.length) {
    causes.push(`Fields with wrong data types: ${wrongType.map((i) => i.field).join(', ')}.`);
    fixes.push('Fix serialization on the sender side (e.g. send numbers as numbers, not strings).');
  }

  if (invalid.length) {
    causes.push(`Fields with invalid values: ${invalid.map((i) => i.field).join(', ')}.`);
    fixes.push('Check the values against the contract rules (e.g. valid email, total not negative, whole-number quantity, ISO date).');
  }

  return {
    source: 'rule-based',
    rootCause: causes.join(' ') || 'Payload does not match the expected contract.',
    suggestedFix: fixes.join(' ') || 'Compare the payload with the contract and correct the differences.',
  };
}

// One call to the Gemini API. It throws on any problem.
async function requestGemini(payload, issues, apiKey) {
  const prompt =
    'You are an API contract triage assistant. A JSON payload failed validation.\n' +
    'Give a concise root cause (max 2 sentences) and a practical fix (max 2 sentences).\n' +
    'Reply ONLY as JSON: {"rootCause": "...", "suggestedFix": "..."}\n\n' +
    `Payload:\n${JSON.stringify(payload, null, 2)}\n\n` +
    `Validation issues:\n${JSON.stringify(issues, null, 2)}`;

  const model = getModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  // Timeout so a slow response doesn't hang the request forever
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(getTimeoutMs()),
  });

  // Model name is in the error so a 404 (retired model) is easy to spot in the log.
  // The status is saved on the error so askGemini() can decide to retry.
  if (!res.ok) {
    const error = new Error(`Gemini responded with HTTP ${res.status} (model: ${model})`);
    error.status = res.status;
    throw error;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');

  const parsed = JSON.parse(text);
  if (!parsed.rootCause || !parsed.suggestedFix) throw new Error('Gemini response missing fields');

  return { source: 'gemini', rootCause: parsed.rootCause, suggestedFix: parsed.suggestedFix };
}

// Calls Gemini, and tries one more time if it answers 503 (server busy).
// Other errors (404 wrong model, 400/403 bad key, timeout) are not retried,
// because trying again would not help or would just make the user wait longer.
async function askGemini(payload, issues, apiKey) {
  try {
    return await requestGemini(payload, issues, apiKey);
  } catch (err) {
    if (err.status !== 503) throw err;
    console.warn('[triage] Gemini returned 503 (busy), retrying once...');
    await new Promise((resolve) => setTimeout(resolve, getRetryDelayMs()));
    return requestGemini(payload, issues, apiKey);
  }
}

// Used by server.js. It never throws, it always returns an explanation.
async function triageDrift(payload, issues) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  // No API key, so go straight to the fallback
  if (!apiKey) return ruleBasedTriage(issues);

  try {
    return await askGemini(payload, issues, apiKey);
  } catch (err) {
    console.warn('[triage] Gemini failed, using rule-based fallback:', err.message);
    return ruleBasedTriage(issues);
  }
}

module.exports = { triageDrift };
