'use strict';
// Date parsing/formatting helpers. All comparisons are calendar-day based.

// Accepts: 2026-08-20, 2026.08.20, 2026/08/20, optionally with HH:MM(:SS).
function parseDate(str) {
  if (!str) return null;
  const m = String(str).match(
    /(20\d\d)[.\-/](\d{1,2})[.\-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const date = new Date(
    Number(y), Number(mo) - 1, Number(d),
    Number(hh || 0), Number(mi || 0), Number(ss || 0)
  );
  return isNaN(date.getTime()) ? null : date;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Inclusive window: today and the previous (days-1) calendar days.
function cutoffFor(days, now) {
  const base = startOfDay(now || new Date());
  return new Date(base.getTime() - (days - 1) * 86400000);
}

function withinDays(date, days, now) {
  if (!date) return false;
  return date.getTime() >= cutoffFor(days, now).getTime();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM' if a time is present.
function isoLocal(date) {
  if (!date) return '';
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (date.getHours() || date.getMinutes() || date.getSeconds()) {
    return `${base} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return base;
}

function stamp(date) {
  const d = date || new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

module.exports = { parseDate, withinDays, cutoffFor, isoLocal, stamp, startOfDay };
