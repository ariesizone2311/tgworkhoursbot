/**
 * Business logic helpers
 */
const dayjs = require('dayjs');

const HOURLY_RATE = 2.5; // $/hour

function usd(amount) {
  return `$${amount.toFixed(2)}`;
}
function formatHours(h) {
  return `${h.toFixed(2)}h`;
}
function weeklyPay(hours) {
  return hours * HOURLY_RATE;
}
function nowUnix() {
  return Math.floor(Date.now() / 1000);
}
function friendlyWeekLabel(weekKeyMonday) {
  const start = dayjs(weekKeyMonday, 'YYYY-MM-DD');
  const end = start.add(6, 'day');
  return `${start.format('MMM D')}–${end.format('MMM D, YYYY')}`;
}

module.exports = {
  HOURLY_RATE,
  usd,
  formatHours,
  weeklyPay,
  nowUnix,
  friendlyWeekLabel,
};
