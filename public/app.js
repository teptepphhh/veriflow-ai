// public/app.js
// Dashboard logic: presets, validate, result, counters, audit log, export,
// plus the confirmation dialog, toast messages, and loading states.

// Same value as API_KEY in .env. There is no login in this local tool,
// so the key is kept here in the frontend.
const API_KEY = 'veriflow-local-key';

// A correct order, used as the base for the sample payloads below
const VALID_ORDER = {
  orderId: 'ORD-1001',
  customerEmail: 'jane@example.com',
  total: 59.98,
  currency: 'USD',
  createdAt: '2026-11-21T10:00:00Z',
  items: [{ sku: 'SKU-1', quantity: 2, price: 29.99 }],
};

// Sample payloads. Each one shows a different kind of problem.
const PRESETS = {
  valid: VALID_ORDER,

  // order_id (renamed), total and quantity are strings,
  // currency is missing, and there is an extra "coupon" field
  drift: {
    order_id: 'ORD-1002',
    customerEmail: 'john@example.com',
    total: '59.98',
    createdAt: '2026-11-21T10:05:00Z',
    items: [{ sku: 'SKU-2', quantity: '1', price: 59.98 }],
    coupon: 'SAVE10',
  },

  // customerEmail and currency are not sent at all
  missing_field: {
    orderId: 'ORD-1003',
    total: 20,
    createdAt: '2026-11-21T10:10:00Z',
    items: [{ sku: 'SKU-3', quantity: 1, price: 20 }],
  },

  // numbers sent as strings
  wrong_type: {
    ...VALID_ORDER,
    orderId: 'ORD-1004',
    total: 'fifty',
    items: [{ sku: 'SKU-4', quantity: '2', price: '29.99' }],
  },

  // the sender renamed two fields (camelCase -> snake_case)
  renamed_field: {
    order_id: 'ORD-1005',
    customer_email: 'maria@example.com',
    total: 35.5,
    currency: 'PHP',
    createdAt: '2026-11-21T10:20:00Z',
    items: [{ sku: 'SKU-5', quantity: 1, price: 35.5 }],
  },

  // right types, but the values break the rules
  invalid_values: {
    orderId: 'ORD-1006',
    customerEmail: 'jane-at-example',
    total: -10,
    currency: 'usd',
    createdAt: 'yesterday',
    items: [{ sku: '', quantity: 0, price: 5 }],
  },

  empty_items: {
    ...VALID_ORDER,
    orderId: 'ORD-1007',
    items: [],
  },
};

// The "Run demo" button goes through these in order
const DEMO_ORDER = ['valid', 'drift', 'missing_field', 'wrong_type', 'renamed_field', 'invalid_values', 'empty_items'];

const $ = (id) => document.getElementById(id);
const input = $('payloadInput');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Escapes HTML characters. The payload comes from the user, so we escape it
// before putting it in innerHTML.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- Toast messages ----------

// Small message that slides in at the bottom right and disappears by itself.
// type: 'info' | 'success' | 'warn' | 'error'
function showToast(message, type = 'info', ms = type === 'error' ? 6000 : 3500) {
  const host = $('toastHost');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = message; // textContent, so nothing can be injected

  const remove = () => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 200);
  };
  toast.addEventListener('click', remove); // click to dismiss
  host.appendChild(toast);

  // Keep at most 4 toasts on screen
  while (host.children.length > 4) host.firstElementChild.remove();

  setTimeout(remove, ms);
}

// ---------- Confirmation dialog ----------

let modalResolve = null;   // the Promise waiting for the user's answer
let lastFocused = null;    // element to focus again after the dialog closes

// Opens the dialog and returns a Promise: true = confirmed, false = cancelled.
// Usage: if (await confirmDialog({ ... })) { ... }
function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    if (modalResolve) closeModal(false); // only one dialog at a time
    lastFocused = document.activeElement;

    $('modalTitle').textContent = title;
    $('modalText').textContent = message;
    $('modalConfirm').textContent = confirmText;
    $('modalConfirm').className = 'btn ' + (danger ? 'btn-confirm-danger' : 'btn-primary');
    document.querySelector('.modal').classList.toggle('danger', danger);

    $('modalBackdrop').hidden = false;
    document.body.classList.add('modal-open');
    modalResolve = resolve;
    $('modalCancel').focus(); // Cancel is focused first so Enter can't confirm by accident
  });
}

function closeModal(result) {
  if (!modalResolve) return;
  const resolve = modalResolve;
  modalResolve = null;
  $('modalBackdrop').hidden = true;
  document.body.classList.remove('modal-open');
  if (lastFocused && lastFocused.focus) lastFocused.focus();
  resolve(result);
}

$('modalConfirm').addEventListener('click', () => closeModal(true));
$('modalCancel').addEventListener('click', () => closeModal(false));
// Click on the dark area outside the box closes it (counts as Cancel)
$('modalBackdrop').addEventListener('click', (e) => {
  if (e.target === $('modalBackdrop')) closeModal(false);
});
document.addEventListener('keydown', (e) => {
  if (!modalResolve) return;
  if (e.key === 'Escape') {
    closeModal(false);
  } else if (e.key === 'Tab') {
    // Keep Tab inside the dialog (it only has two buttons)
    const first = $('modalCancel');
    const last = $('modalConfirm');
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

// ---------- Messages, editor helpers ----------

// Shows a message under the editor. isInfo = blue text instead of red error text.
function showMessage(text, isInfo = false) {
  $('message').textContent = text || '';
  $('message').className = 'message' + (isInfo ? ' info' : '');
}

// Updates the line/character count in the editor title bar
function updateEditorHint() {
  const lines = input.value ? input.value.split('\n').length : 0;
  $('editorHint').textContent = `JSON · ${lines} lines · ${input.value.length} chars`;
}

function loadPreset(name) {
  input.value = JSON.stringify(PRESETS[name], null, 2);
  updateEditorHint();
  showMessage('');
}

// "Format JSON" button: re-indents the JSON, or explains what is wrong
function formatJson() {
  if (!input.value.trim()) {
    showMessage('The editor is empty, there is nothing to format.');
    showToast('Nothing to format: the editor is empty', 'warn');
    return;
  }
  try {
    input.value = JSON.stringify(JSON.parse(input.value), null, 2);
    updateEditorHint();
    showMessage('');
    showToast('JSON formatted', 'success', 2200);
  } catch (err) {
    showMessage('Cannot format, invalid JSON: ' + err.message);
    showToast('Cannot format: the JSON is invalid', 'error');
  }
}

// Copies text to the clipboard and shows a toast
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied to clipboard`, 'success', 2200);
  } catch {
    showToast('Could not copy. Select the text and press Ctrl+C instead.', 'error');
  }
}

// ---------- Busy state (loading) ----------

let isBusy = false; // true while a validation or the demo is running
const BUSY_CONTROLS = ['validateBtn', 'demoBtn', 'presetValid', 'presetDrift', 'presetSelect', 'formatBtn', 'clearBtn'];

// Disables the buttons so nothing can be clicked twice or change the editor mid-run
function setBusy(flag) {
  isBusy = flag;
  BUSY_CONTROLS.forEach((id) => { $(id).disabled = flag; });
  input.readOnly = flag;
}

// Spinner + "Validating & triaging..." text on the Validate button
function setValidateLoading(on) {
  $('validateBtn').classList.toggle('loading', on);
  $('validateBtn').querySelector('.spinner').hidden = !on;
  $('validateBtn').querySelector('.play-icon').style.display = on ? 'none' : '';
  $('validateLabel').textContent = on ? 'Validating & triaging...' : 'Validate payload';
}

let loadingTimer = null;

// Loading card in the Result panel, with a seconds counter
// (Gemini can take a while, so the user can see it is still working)
function showResultLoading() {
  $('result').className = 'result-loading';
  $('result').innerHTML = `
    <div class="spinner big" aria-hidden="true"></div>
    <strong>Validating &amp; triaging...</strong>
    <span>Checking the contract, then asking Gemini for a root cause. <b id="loadingSeconds">0</b>s</span>`;
  const started = Date.now();
  loadingTimer = setInterval(() => {
    const el = $('loadingSeconds');
    if (el) el.textContent = Math.floor((Date.now() - started) / 1000);
  }, 1000);
}

function stopResultLoading() {
  clearInterval(loadingTimer);
  loadingTimer = null;
}

// ---------- Result panel ----------

// Small label showing where the explanation came from ("gemini" or "rule-based")
function sourceChip(source) {
  return `<span class="chip src ${esc(source)}">${esc(source)}</span>`;
}

// Copy button. The text to copy is kept in a data attribute (see the click handler below)
function copyButton(text, label) {
  return `<button class="copy-btn" data-copy="${esc(text)}" data-label="${esc(label)}">Copy</button>`;
}

// One row per issue: type label, field path, and message
function issueListHtml(issues) {
  return `<ul class="issue-list">${issues.map((i) => `
    <li class="${esc(i.type)}">
      <div class="issue-head">
        <span class="chip ${esc(i.type)}">${esc(i.type)}</span>
        <span class="issue-field">${esc(i.field)}</span>
      </div>
      <div class="issue-msg">${esc(i.message)}</div>
    </li>`).join('')}</ul>`;
}

let lastResultLog = null; // the result shown in the Result panel (used by "Apply fix to editor")

function renderResult(log) {
  lastResultLog = log;
  const count = log.issues.length;

  // Status banner (VALID or DRIFT_DETECTED)
  const verdict = `
    <div class="verdict ${esc(log.status)}">
      <strong><span class="verdict-icon" aria-hidden="true">${log.status === 'VALID' ? '&#10003;' : '!'}</span>${esc(log.status)}</strong>
      <small>${count} issue${count === 1 ? '' : 's'} &middot; ${esc(new Date(log.timestamp).toLocaleTimeString())}</small>
    </div>`;

  const issues = count
    ? issueListHtml(log.issues)
    : '<p class="no-issues">All required fields, types, and values match the contract.</p>';

  // The "Apply fix to editor" button needs a drift result with a JSON object payload.
  // For anything else (valid, or an array/text payload) it is not shown.
  const payloadIsObject = log.payload !== null && typeof log.payload === 'object' && !Array.isArray(log.payload);
  const applyButton = log.status === 'DRIFT_DETECTED' && payloadIsObject
    ? '<button class="copy-btn apply-btn" id="applyFixBtn" title="Fix the JSON in the editor (renames, types, values). Then click Validate to re-check.">Apply fix to editor</button>'
    : '';

  // Only drifted payloads have a root cause and fix (valid ones have triage = null)
  const triage = log.triage
    ? `<div class="triage-card">
         <div class="triage-head">Root cause ${sourceChip(log.triage.source)}</div>
         <div class="triage-body">${esc(log.triage.rootCause)}</div>
       </div>
       <div class="triage-card fix">
         <div class="triage-head">Suggested fix <span class="card-actions">${copyButton(log.triage.suggestedFix, 'Suggested fix')}${applyButton}</span></div>
         <div class="triage-body">${esc(log.triage.suggestedFix)}</div>
       </div>`
    : '';

  $('result').className = '';
  $('result').innerHTML =
    `${verdict}<div class="section-title">Field-level issues</div>${issues}${triage}`;
}

function renderSummary(logs) {
  const drift = logs.filter((l) => l.status === 'DRIFT_DETECTED').length;
  $('countTotal').textContent = logs.length;
  $('countDrift').textContent = drift;
  $('countValid').textContent = logs.length - drift;
}

// ---------- Audit log (filter + expandable rows) ----------

let currentLogs = [];        // copy of the latest logs, also used by the export buttons
let logFilter = 'all';       // 'all', 'VALID' or 'DRIFT_DETECTED'
const expandedIds = new Set(); // ids of rows whose details are open

// The extra row shown under a log when you click it
function detailRowHtml(l) {
  const alertText = l.status === 'VALID'
    ? 'Not needed (payload is valid)'
    : (l.webhookSent ? 'Webhook alert sent' : 'No alert sent (webhook not set, or it failed)');
  const payloadText = JSON.stringify(l.payload, null, 2);

  return `
    <tr class="detail-row">
      <td colspan="5">
        <div class="detail">
          <div>
            <div class="detail-title"><h4>Payload</h4>${copyButton(payloadText, 'Payload')}</div>
            <pre class="payload-json">${esc(payloadText)}</pre>
          </div>
          <div>
            <div class="detail-title"><h4>Issues (${l.issues.length})</h4></div>
            ${l.issues.length ? issueListHtml(l.issues) : '<p class="no-issues">No issues.</p>'}
            ${l.triage ? `<div class="detail-title"><h4>Suggested fix</h4>${copyButton(l.triage.suggestedFix, 'Suggested fix')}</div><p>${esc(l.triage.suggestedFix)}</p>` : ''}
            <div class="detail-title"><h4>Alert</h4></div>
            <p>${esc(alertText)}</p>
          </div>
        </div>
      </td>
    </tr>`;
}

// Draws the table using the current filter
function drawLogTable() {
  const shown = currentLogs.filter((l) => logFilter === 'all' || l.status === logFilter);
  $('logCount').textContent = currentLogs.length
    ? `Showing ${shown.length} of ${currentLogs.length} · click a row for details`
    : '';

  if (!currentLogs.length) {
    $('logBody').innerHTML = '<tr><td colspan="5" class="empty-cell">No logs yet. Validate a payload to create the first entry.</td></tr>';
    return;
  }
  if (!shown.length) {
    $('logBody').innerHTML = '<tr><td colspan="5" class="empty-cell">No logs match this filter.</td></tr>';
    return;
  }

  // Columns: Time, Status, Issues, Source, Root cause
  $('logBody').innerHTML = shown.map((l) => {
    const open = expandedIds.has(l.id);
    return `
    <tr class="log-row ${open ? 'open' : ''}" data-id="${esc(l.id)}" tabindex="0" aria-expanded="${open}">
      <td class="log-time">${esc(new Date(l.timestamp).toLocaleString())}</td>
      <td><span class="badge ${esc(l.status)}">${esc(l.status)}</span></td>
      <td class="log-issues">${l.issues.length}</td>
      <td>${l.triage ? sourceChip(l.triage.source) : '<span class="dash">-</span>'}</td>
      <td class="log-cause">${l.triage ? esc(l.triage.rootCause) : '<span class="dash">-</span>'}</td>
    </tr>${open ? detailRowHtml(l) : ''}`;
  }).join('');
}

function renderLogs(logs) {
  currentLogs = logs;
  renderSummary(logs);
  drawLogTable();
}

// Open or close the details of one row
function toggleRow(id) {
  if (expandedIds.has(id)) expandedIds.delete(id);
  else expandedIds.add(id);
  drawLogTable();
}

async function loadLogs() {
  try {
    const res = await fetch('/api/logs');
    if (!res.ok) throw new Error('bad response');
    renderLogs(await res.json());
  } catch {
    showMessage('Could not load logs. Is the server running?');
    showToast('Could not load logs. Is the server running?', 'error');
    // Replace the "Loading logs..." row if nothing was loaded yet
    if (!currentLogs.length) {
      $('logBody').innerHTML = '<tr><td colspan="5" class="empty-cell">Could not load logs.</td></tr>';
    }
  }
}

// ---------- Validate ----------

// Sends one payload to the server and shows the result.
// quiet = true skips the "validation complete" toast (the demo shows its own).
// Returns true if it worked.
async function submitPayload(payload, { quiet = false } = {}) {
  // Remember the old result so it can come back if the request fails
  const oldHtml = $('result').innerHTML;
  const oldClass = $('result').className;
  const restoreResult = () => {
    $('result').className = oldClass;
    $('result').innerHTML = oldHtml;
  };

  showResultLoading();
  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    stopResultLoading();

    if (!res.ok) {
      restoreResult();
      const text = data.error || 'Validation request failed.';
      showMessage(text);
      showToast(text, 'error');
      return false;
    }

    renderResult(data);
    await loadLogs();
    if (!quiet) {
      const n = data.issues.length;
      if (data.status === 'VALID') showToast('Validation complete: payload is VALID', 'success');
      else showToast(`Validation complete: drift detected (${n} issue${n === 1 ? '' : 's'})`, 'warn');
    }
    return true;
  } catch {
    stopResultLoading();
    restoreResult();
    showMessage('Could not reach the server.');
    showToast('Could not reach the server. Is it running?', 'error');
    return false;
  }
}

async function validate() {
  if (isBusy) return; // ignores double clicks and Ctrl+Enter while working
  showMessage('');

  // Parse the JSON here first, so invalid JSON shows a clear message
  // and is not sent to the server
  let payload;
  try {
    payload = JSON.parse(input.value);
  } catch (err) {
    showMessage('Invalid JSON: ' + err.message);
    showToast('Invalid JSON syntax. Fix it and try again.', 'error');
    return;
  }

  setBusy(true);
  setValidateLoading(true);
  await submitPayload(payload);
  setValidateLoading(false);
  setBusy(false);
}

// Validates every sample payload one by one, so a demo needs only one click
async function runDemo() {
  if (isBusy) return;
  const total = DEMO_ORDER.length;

  const ok = await confirmDialog({
    title: 'Run the demo?',
    message: `This runs all ${total} scenarios one after another and adds ${total} entries to the audit log. Every drift result also calls Gemini and sends a Slack alert if a webhook is set.`,
    confirmText: 'Run demo',
  });
  if (!ok) return;

  setBusy(true);
  $('demoProgress').hidden = false;
  let done = 0;

  for (let i = 0; i < total; i++) {
    const name = DEMO_ORDER[i];
    $('demoProgressText').textContent = `Running scenario ${i + 1} of ${total}: ${name.replace(/_/g, ' ')}`;
    $('demoProgressBar').style.width = `${(i / total) * 100}%`;

    loadPreset(name);
    const success = await submitPayload(PRESETS[name], { quiet: true });
    if (!success) break; // stop if the server has a problem

    done++;
    $('demoProgressBar').style.width = `${(done / total) * 100}%`;
    if (i < total - 1) await sleep(1200); // short pause so the result can be read
  }

  await sleep(500);
  $('demoProgress').hidden = true;
  $('demoProgressBar').style.width = '0';
  setBusy(false);

  if (done === total) showToast(`Demo finished: ${total} scenarios validated`, 'success');
  else showToast(`Demo stopped after ${done} of ${total} scenarios`, 'error');
}

async function clearLogs() {
  if (isBusy) return;
  const count = currentLogs.length;
  if (!count) {
    showToast('There are no logs to clear', 'info');
    return;
  }

  const ok = await confirmDialog({
    title: 'Clear all logs?',
    message: `This permanently deletes ${count} audit log ${count === 1 ? 'entry' : 'entries'} and cannot be undone. Tip: use Export JSON first if you want a backup.`,
    confirmText: 'Clear logs',
    danger: true,
  });
  if (!ok) return;

  try {
    const res = await fetch('/api/logs', { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
    if (!res.ok) {
      showToast((await res.json()).error || 'Could not clear logs.', 'error');
      return;
    }
    expandedIds.clear();
    await loadLogs();
    showToast(`Cleared ${count} log${count === 1 ? '' : 's'}`, 'success');
  } catch {
    showToast('Could not reach the server. Is it running?', 'error');
  }
}

// Gets the contract from /api/schema (only one request, the answer is reused)
let schemaPromise = null;
function loadSchema() {
  if (!schemaPromise) {
    schemaPromise = fetch('/api/schema')
      .then((res) => {
        if (!res.ok) throw new Error('bad response');
        return res.json();
      })
      .catch((err) => {
        schemaPromise = null; // allow a retry next time
        throw err;
      });
  }
  return schemaPromise;
}

// ---------- Apply fix to editor ----------

// Puts a corrected version of the payload into the editor.
// It does NOT validate: the user clicks Validate (or Ctrl+Enter) to see before and after.
async function applyFix() {
  if (isBusy) return;

  // Fix what is in the editor now. If that is not valid JSON, use the payload that was validated.
  let payload;
  try {
    payload = JSON.parse(input.value);
  } catch {
    payload = lastResultLog && lastResultLog.payload;
  }

  let schema;
  try {
    schema = await loadSchema();
  } catch {
    showToast('Could not load the contract, so the fix cannot be applied.', 'error');
    return;
  }

  // applyContractFix comes from fixer.js
  const result = applyContractFix(payload, schema.order, schema.item);
  if (!result) {
    showToast('Cannot apply a fix: the payload is not a JSON object.', 'warn');
    return;
  }

  const fixedText = JSON.stringify(result.fixed, null, 2);
  if (fixedText === JSON.stringify(payload, null, 2)) {
    showToast('Nothing to fix: the editor already matches the contract.', 'info');
    return;
  }

  // Put the fixed JSON in the editor and bring the cursor to the top
  input.value = fixedText;
  updateEditorHint();
  input.focus();
  input.setSelectionRange(0, 0);
  input.scrollTop = 0;

  // Short glow on the editor so the change is easy to see
  const editor = document.querySelector('.editor');
  editor.classList.add('applied');
  setTimeout(() => editor.classList.remove('applied'), 1200);

  // Tell the user what changed (first few changes) and which values are placeholders
  const n = result.changes.length;
  let summary = result.changes.slice(0, 4).join(' · ');
  if (n > 4) summary += ` · +${n - 4} more`;
  if (result.placeholders.length) {
    summary += `. Placeholder values were added for: ${[...new Set(result.placeholders)].join(', ')}. Replace them with real data.`;
  }
  showMessage(summary, true);
  showToast(`Applied suggested fix to editor (${n} change${n === 1 ? '' : 's'}) — click Validate to re-check`, 'success', 5000);
}

// ---------- Expected contract toggle ----------

// Short text describing the value rules of a field, e.g. "min 0, whole number"
function ruleHints(rule) {
  const hints = [];
  if (rule.minLength) hints.push('not empty');
  if (rule.format === 'email') hints.push('valid email');
  if (rule.format === 'currency') hints.push('3-letter code');
  if (rule.format === 'iso-date') hints.push('ISO date');
  if (rule.integer) hints.push('whole number');
  if (rule.min !== undefined) hints.push(`min ${rule.min}`);
  if (rule.minItems) hints.push(`at least ${rule.minItems} item`);
  return hints.join(', ');
}

// Builds a small table (field, type, required) from a schema object
function schemaTable(title, schema) {
  const rows = Object.entries(schema).map(([name, rule]) => {
    const hints = ruleHints(rule);
    return `
    <tr>
      <td><code>${esc(name)}</code>${hints ? `<div class="rule-hint">${esc(hints)}</div>` : ''}</td>
      <td>${esc(rule.type)}</td>
      <td class="${rule.required ? 'req' : 'opt'}">${rule.required ? 'required' : 'optional'}</td>
    </tr>`;
  }).join('');
  // The div lets the two tables sit side by side
  return `<div><h4>${esc(title)}</h4><table><tbody>${rows}</tbody></table></div>`;
}

let contractLoaded = false;

async function toggleContract() {
  const box = $('contractBox');
  const btn = $('contractToggle');
  const willOpen = box.hidden;

  // Load the schema from the server only the first time it is opened
  if (willOpen && !contractLoaded) {
    box.innerHTML = '<div class="contract-loading"><span class="spinner small" aria-hidden="true"></span> Loading contract...</div>';
    box.hidden = false;
    try {
      const schema = await loadSchema();
      box.innerHTML = schemaTable('Order', schema.order) + schemaTable('Each item in "items"', schema.item);
      contractLoaded = true;
    } catch {
      box.hidden = true;
      showToast('Could not load the expected contract.', 'error');
      return;
    }
  }

  box.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
  btn.textContent = willOpen ? 'Hide expected contract' : 'View expected contract';
}

// ---------- Export logs ----------

// Downloads text as a file (creates a temporary link and clicks it)
function downloadFile(filename, content, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// CSV escaping: if a value has a comma, quote, or new line, wrap it in quotes
// and double any quotes inside it
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// Byte order mark, added at the start of the CSV file
const BOM = String.fromCharCode(0xfeff);

function logsToCsv(logs) {
  const header = ['id', 'timestamp', 'status', 'issue_count', 'issues', 'root_cause', 'suggested_fix', 'triage_source'];
  const rows = logs.map((l) => [
    l.id,
    l.timestamp,
    l.status,
    l.issues.length,
    l.issues.map((i) => `${i.type}: ${i.field}`).join('; '),
    l.triage ? l.triage.rootCause : '',
    l.triage ? l.triage.suggestedFix : '',
    l.triage ? l.triage.source : '',
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// Exports ALL logs (not only the filtered ones)
function exportLogs(format) {
  if (!currentLogs.length) {
    showMessage('No logs to export yet. Validate a payload first.');
    showToast('No logs to export yet. Validate a payload first.', 'warn');
    return;
  }
  showMessage('');
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    downloadFile(`veriflow-logs-${stamp}.json`, JSON.stringify(currentLogs, null, 2), 'application/json');
  } else {
    // A BOM at the start makes Excel read the file as UTF-8
    downloadFile(`veriflow-logs-${stamp}.csv`, BOM + logsToCsv(currentLogs), 'text/csv;charset=utf-8');
  }
  const n = currentLogs.length;
  showToast(`Exported ${n} log${n === 1 ? '' : 's'} as ${format.toUpperCase()}`, 'success');
}

// ---------- Events ----------

$('contractToggle').addEventListener('click', toggleContract);
$('exportJsonBtn').addEventListener('click', () => exportLogs('json'));
$('exportCsvBtn').addEventListener('click', () => exportLogs('csv'));
input.addEventListener('input', updateEditorHint);
$('presetValid').addEventListener('click', () => loadPreset('valid'));
$('presetDrift').addEventListener('click', () => loadPreset('drift'));
$('presetSelect').addEventListener('change', (e) => {
  if (e.target.value) loadPreset(e.target.value);
  e.target.value = ''; // back to the "More scenarios..." label
});
$('demoBtn').addEventListener('click', runDemo);
$('validateBtn').addEventListener('click', validate);
$('clearBtn').addEventListener('click', clearLogs);
$('formatBtn').addEventListener('click', formatJson);
$('copyPayloadBtn').addEventListener('click', () => {
  if (!input.value.trim()) {
    showToast('The editor is empty, nothing to copy', 'warn');
    return;
  }
  copyText(input.value, 'Payload');
});

// Ctrl + Enter (or Cmd + Enter on Mac) inside the editor validates the payload
input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    validate();
  }
});

// All "Copy" buttons in the result and log details (text is in data-copy)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (btn) copyText(btn.dataset.copy, btn.dataset.label || 'Text');
});

// Sets the log filter ('all', 'VALID' or 'DRIFT_DETECTED') and updates the
// filter buttons, the counter cards, and the table so they all agree
function setLogFilter(filter) {
  logFilter = filter;
  document.querySelectorAll('#logFilter .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  document.querySelectorAll('.stat[data-filter]').forEach((card) => {
    card.setAttribute('aria-pressed', String(card.dataset.filter === filter));
  });
  drawLogTable();
}

// "Apply fix to editor" button (it is created inside the Result panel)
document.addEventListener('click', (e) => {
  if (e.target.closest('#applyFixBtn')) applyFix();
});

// Filter buttons: All / Valid / Drift
$('logFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) setLogFilter(btn.dataset.filter);
});

// Counter cards: filter the audit log, then scroll down to it
function openLogsFor(filter) {
  setLogFilter(filter);
  const panel = $('auditLog');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  panel.classList.add('flash'); // short glow on the table
  setTimeout(() => panel.classList.remove('flash'), 1200);
}

document.querySelector('.stats').addEventListener('click', (e) => {
  const card = e.target.closest('.stat[data-filter]');
  if (card) openLogsFor(card.dataset.filter);
});
document.querySelector('.stats').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.stat[data-filter]');
  if (card) {
    e.preventDefault();
    openLogsFor(card.dataset.filter);
  }
});

// Click (or Enter/Space) on a log row opens its details
$('logBody').addEventListener('click', (e) => {
  const row = e.target.closest('tr.log-row');
  if (row) toggleRow(row.dataset.id);
});
$('logBody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('tr.log-row');
  if (row) {
    e.preventDefault();
    toggleRow(row.dataset.id);
  }
});

loadPreset('valid');
loadLogs();
