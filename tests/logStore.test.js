// tests/logStore.test.js
// Tests for the JSON log storage. LOG_FILE points to a temp file so the real
// data/logs.json is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must be set BEFORE logStore is loaded
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-logstore-'));
process.env.LOG_FILE = path.join(tempDir, 'logs.json');

const { readLogs, appendLog, clearLogs, MAX_LOGS } = require('../storage/logStore');

test.beforeEach(() => clearLogs());
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('a fresh store starts empty', () => {
  assert.deepEqual(readLogs(), []);
});

test('appendLog adds an id and timestamp, and keeps the entry fields', () => {
  const saved = appendLog({ status: 'VALID', issues: [] });
  assert.equal(saved.status, 'VALID');
  assert.ok(saved.id, 'has an id');
  assert.ok(!Number.isNaN(Date.parse(saved.timestamp)), 'has a valid timestamp');
  assert.equal(readLogs().length, 1);
});

test('newest log comes first', () => {
  appendLog({ status: 'VALID', label: 'first' });
  appendLog({ status: 'DRIFT_DETECTED', label: 'second' });
  assert.equal(readLogs()[0].label, 'second');
});

test('clearLogs empties the file', () => {
  appendLog({ status: 'VALID' });
  clearLogs();
  assert.deepEqual(readLogs(), []);
});

test('a corrupted file does not crash, it reads as empty', () => {
  fs.writeFileSync(process.env.LOG_FILE, '{ this is not json');
  assert.deepEqual(readLogs(), []);
});

test('only the newest MAX_LOGS entries are kept', () => {
  for (let i = 0; i < MAX_LOGS + 5; i++) appendLog({ status: 'VALID', n: i });

  const logs = readLogs();
  assert.equal(logs.length, MAX_LOGS);
  assert.equal(logs[0].n, MAX_LOGS + 4); // newest is still there
  assert.ok(!logs.some((l) => l.n === 0), 'the oldest was dropped');
});
