// services/webhookService.js
// Sends an optional alert to Slack (or Discord) when drift is detected.
// If WEBHOOK_URL is empty it just skips. If sending fails, we only log it,
// so a broken webhook never stops the validation.

async function sendDriftAlert(entry) {
  const url = (process.env.WEBHOOK_URL || '').trim();
  if (!url) return { sent: false, reason: 'WEBHOOK_URL not set' };

  // Slack formatting: *text* is bold
  const text =
    `:rotating_light: *Veriflow: DRIFT_DETECTED* (${entry.issues.length} issue(s))\n` +
    `*Root cause:* ${entry.triage.rootCause}\n` +
    `*Suggested fix:* ${entry.triage.suggestedFix}`;

  // Slack wants { text }. Discord wants { content }, so other URLs get both.
  const isSlack = url.startsWith('https://hooks.slack.com/');
  const body = isSlack ? { text } : { content: text, text };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { sent: true };
  } catch (err) {
    console.warn('[webhook] Alert failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendDriftAlert };
