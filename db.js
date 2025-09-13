/**
 * SQLite data layer for the Work Hours bot
 * Uses better-sqlite3 (sync, zero-config) for reliability.
 */
const Database = require('better-sqlite3');
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek');
dayjs.extend(isoWeek);

// Open (or create) the DB file
const db = new Database('data.db');

// Create tables if they don't exist
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  user_id     INTEGER PRIMARY KEY,
  username    TEXT,
  first_name  TEXT,
  last_name   TEXT
);

CREATE TABLE IF NOT EXISTS shifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  start_ts   INTEGER NOT NULL,
  end_ts     INTEGER,
  day_key    TEXT NOT NULL,
  week_key   TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_shifts_user_week ON shifts(user_id, week_key);
CREATE INDEX IF NOT EXISTS idx_shifts_user_day  ON shifts(user_id, day_key);
`);

/** Helpers **/
function isoMonday(dateOrTs) {
  const d = typeof dateOrTs === 'number' ? dayjs.unix(dateOrTs) : dayjs(dateOrTs);
  return d.isoWeekday(1).format('YYYY-MM-DD'); // Monday of ISO week
}
function dayKey(dateOrTs) {
  const d = typeof dateOrTs === 'number' ? dayjs.unix(dateOrTs) : dayjs(dateOrTs);
  return d.format('YYYY-MM-DD');
}

/** Users **/
const upsertUserStmt = db.prepare(`
INSERT INTO users (user_id, username, first_name, last_name)
VALUES (@user_id, @username, @first_name, @last_name)
ON CONFLICT(user_id) DO UPDATE SET
  username=excluded.username,
  first_name=excluded.first_name,
  last_name=excluded.last_name
`);
function upsertUser(from) {
  upsertUserStmt.run({
    user_id: from.id,
    username: from.username || null,
    first_name: from.first_name || null,
    last_name: from.last_name || null
  });
}

/** Shifts **/
const getOpenShiftStmt = db.prepare(`
SELECT * FROM shifts WHERE user_id = ? AND end_ts IS NULL ORDER BY id DESC LIMIT 1
`);
const startShiftStmt = db.prepare(`
INSERT INTO shifts (user_id, start_ts, end_ts, day_key, week_key)
VALUES (?, ?, NULL, ?, ?)
`);
const endShiftStmt = db.prepare(`UPDATE shifts SET end_ts = ? WHERE id = ?`);

function clockIn(userId, nowTs) {
  const open = getOpenShiftStmt.get(userId);
  if (open) return { ok: false, message: 'You are already clocked IN. Use /out to clock out.' };
  startShiftStmt.run(userId, nowTs, dayKey(nowTs), isoMonday(nowTs));
  return { ok: true, message: `Clocked IN at ${dayjs.unix(nowTs).format('HH:mm')}` };
}
function clockOut(userId, nowTs) {
  const open = getOpenShiftStmt.get(userId);
  if (!open) return { ok: false, message: 'No active shift to clock OUT from. Use /in first.' };
  endShiftStmt.run(nowTs, open.id);
  const hours = durationHours(open.start_ts, nowTs);
  return { ok: true, message: `Clocked OUT at ${dayjs.unix(nowTs).format('HH:mm')} (${hours.toFixed(2)}h)` };
}

/** Queries **/
const sumDayStmt = db.prepare(`
SELECT SUM(CASE WHEN end_ts IS NOT NULL THEN (end_ts - start_ts)/3600.0 ELSE 0 END) AS hours
FROM shifts WHERE user_id = ? AND day_key = ?
`);
const sumWeekStmt = db.prepare(`
SELECT SUM(CASE WHEN end_ts IS NOT NULL THEN (end_ts - start_ts)/3600.0 ELSE 0 END) AS hours
FROM shifts WHERE user_id = ? AND week_key = ?
`);
const listWeekStmt = db.prepare(`
SELECT id, day_key, start_ts, end_ts
FROM shifts
WHERE user_id = ? AND week_key = ?
ORDER BY start_ts ASC
`);
const deleteDayStmt = db.prepare(`DELETE FROM shifts WHERE user_id = ? AND day_key = ?`);
const deleteWeekStmt = db.prepare(`DELETE FROM shifts WHERE user_id = ? AND week_key = ?`);

/** Utils **/
function durationHours(startTs, endTs) {
  return Math.max(0, (endTs - startTs) / 3600);
}
function getTodayHours(userId, nowTs) {
  const today = dayKey(nowTs);
  const row = sumDayStmt.get(userId, today);
  return Number(row?.hours || 0);
}
function getWeekHours(userId, nowTs) {
  const week = isoMonday(nowTs);
  const row = sumWeekStmt.get(userId, week);
  return { hours: Number(row?.hours || 0), weekKey: week };
}
function exportWeekCSV(userId, nowTs) {
  const week = isoMonday(nowTs);
  const rows = listWeekStmt.all(userId, week);
  const header = 'id,day,start,end,hours\n';
  const body = rows.map(r => {
    const start = dayjs.unix(r.start_ts).format('YYYY-MM-DD HH:mm');
    const end = r.end_ts ? dayjs.unix(r.end_ts).format('YYYY-MM-DD HH:mm') : '';
    const hrs = r.end_ts ? durationHours(r.start_ts, r.end_ts).toFixed(2) : '0.00';
    return [r.id, r.day_key, start, end, hrs].join(',');
  }).join('\n');
  return { weekKey: week, csv: header + body + '\n' };
}
function resetDay(userId, nowTs) {
  const today = dayKey(nowTs);
  return deleteDayStmt.run(userId, today).changes;
}
function resetWeek(userId, nowTs) {
  const week = isoMonday(nowTs);
  return deleteWeekStmt.run(userId, week).changes;
}

module.exports = {
  db,
  upsertUser,
  clockIn,
  clockOut,
  getTodayHours,
  getWeekHours,
  exportWeekCSV,
  resetDay,
  resetWeek
};
