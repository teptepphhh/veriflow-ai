// storage/logStore.js
// Saves audit logs in a JSON file (data/logs.json) so no database is needed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// LOG_FILE can be changed with an environment variable. The tests use this
// so they write to a temp file and never touch the real data/logs.json.
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, '..', 'data', 'logs.json');
const DATA_DIR = path.dirname(LOG_FILE);

// Keep only the newest logs so the file can't grow forever
const MAX_LOGS = 200;

// Creates the data folder and file if they don't exist yet
function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]');
}

function readLogs() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    // File is broken (maybe edited by hand), so start with an empty list
    return [];
  }
}

function writeLogs(logs) {
  ensureFile();
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// Adds a new log at the top so the newest one shows first
function appendLog(entry) {
  const logs = readLogs();
  const saved = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  logs.unshift(saved);
  writeLogs(logs.slice(0, MAX_LOGS)); // drops the oldest ones past the limit
  return saved;
}

function clearLogs() {
  writeLogs([]);
}

module.exports = { readLogs, appendLog, clearLogs, MAX_LOGS };
