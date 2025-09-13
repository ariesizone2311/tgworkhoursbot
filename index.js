require('dotenv').config();
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const isoWeek = require('dayjs/plugin/isoWeek');
dayjs.extend(utc);
dayjs.extend(tz);
dayjs.extend(isoWeek);
dayjs.tz.setDefault('Asia/Manila');

const {
  db,
  upsertUser,
  clockIn,
  clockOut,
  getTodayHours,
  getWeekHours,
  exportWeekCSV,
  resetDay,
  resetWeek,
} = require('./db');

const {
  HOURLY_RATE,
  usd,
  formatHours,
  weeklyPay,
  nowUnix,
  friendlyWeekLabel,
} = require('./services');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

/** Utils */
function replyUsage(ctx) {
  return ctx.reply(
    [
      'Commands:',
      '/start - Set up your profile',
      '/in - Clock in',
      '/out - Clock out',
      '/today - Show today’s hours',
      '/week - Show this week’s hours',
      `/pay - Show this week’s pay ($${HOURLY_RATE}/hr)`,
      '/resetday - Clear today’s entries',
      '/resetweek - Clear this week’s entries',
      '/export - Export this week CSV',
      '/help - Show help',
    ].join('\n')
  );
}

/** Middleware: capture user to DB */
bot.use(async (ctx, next) => {
  try {
    if (ctx.from) upsertUser(ctx.from);
  } catch (e) {
    console.error('upsertUser error:', e);
  }
  return next();
});

/** Commands */
bot.start((ctx) => {
  ctx.reply(
    `Welcome, ${ctx.from.first_name || 'friend'}!\n` +
    `Use /in to clock in and /out to clock out.\n` +
    `Rate: $${HOURLY_RATE}/hour.\n\n` +
    `Type /help to see all commands.`
  );
});

bot.command('help', replyUsage);

bot.command('in', (ctx) => {
  const res = clockIn(ctx.from.id, nowUnix());
  ctx.reply(res.message);
});

bot.command('out', (ctx) => {
  const res = clockOut(ctx.from.id, nowUnix());
  ctx.reply(res.message);
});

bot.command('today', (ctx) => {
  const h = getTodayHours(ctx.from.id, nowUnix());
  ctx.reply(`Today: ${formatHours(h)}`);
});

bot.command('week', (ctx) => {
  const { hours, weekKey } = getWeekHours(ctx.from.id, nowUnix());
  ctx.reply(`Week ${friendlyWeekLabel(weekKey)}: ${formatHours(hours)}`);
});

bot.command('pay', (ctx) => {
  const { hours, weekKey } = getWeekHours(ctx.from.id, nowUnix());
  const pay = weeklyPay(hours);
  ctx.reply(
    `Week ${friendlyWeekLabel(weekKey)}\n` +
    `Hours: ${formatHours(hours)}\n` +
    `Rate: $${HOURLY_RATE}/hr\n` +
    `Pay: ${usd(pay)}`
  );
});

bot.command('resetday', (ctx) => {
  const n = resetDay(ctx.from.id, nowUnix());
  ctx.reply(`Deleted ${n} entries for today.`);
});

bot.command('resetweek', (ctx) => {
  const n = resetWeek(ctx.from.id, nowUnix());
  ctx.reply(`Deleted ${n} entries for this week.`);
});

bot.command('export', async (ctx) => {
  const { weekKey, csv } = exportWeekCSV(ctx.from.id, nowUnix());
  const filename = `workweek_${weekKey}.csv`;
  await ctx.replyWithDocument(
    { source: Buffer.from(csv, 'utf8'), filename },
    { caption: `Export for ${friendlyWeekLabel(weekKey)}` }
  );
});

/**
 * Weekly payout message
 * Runs every Sunday at 23:00 Asia/Manila
 */
const listUsersStmt = db.prepare('SELECT user_id FROM users');
cron.schedule(
  '0 23 * * 0', // 23:00 every Sunday
  async () => {
    try {
      const users = listUsersStmt.all().map((r) => r.user_id);
      for (const userId of users) {
        const { hours, weekKey } = getWeekHours(userId, Math.floor(Date.now() / 1000));
        const pay = weeklyPay(hours);

        await bot.telegram.sendMessage(
          userId,
          [
            `Weekly Summary (${friendlyWeekLabel(weekKey)}):`,
            `Hours: ${formatHours(hours)}`,
            `Rate: $${HOURLY_RATE}/hr`,
            `Pay: ${usd(pay)}`,
          ].join('\n')
        );

        const { csv } = exportWeekCSV(userId, Math.floor(Date.now() / 1000));
        const filename = `workweek_${weekKey}.csv`;
        await bot.telegram.sendDocument(userId, { source: Buffer.from(csv, 'utf8'), filename });
      }
      console.log('[cron] Weekly payout messages sent.');
    } catch (err) {
      console.error('[cron] Error sending weekly summaries:', err);
    }
  },
  { timezone: 'Asia/Manila' }
);/**
 * Admin-only commands
 * Show all users' weekly totals and pay
 */
const listUsersFullStmt = db.prepare(`
  SELECT u.user_id, u.username, u.first_name, u.last_name
  FROM users u
  ORDER BY COALESCE(u.username, u.first_name, u.user_id)
`);

bot.command('allhours', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') {
    const users = listUsersFullStmt.all();
    if (!users.length) return ctx.reply('No users found.');

    let report = '📊 Weekly Hours (All Users):\n\n';
    for (const u of users) {
      const { hours, weekKey } = getWeekHours(u.user_id, nowUnix());
      const name = u.username
        ? '@' + u.username
        : (u.first_name || 'User ' + u.user_id);
      report += `${name}: ${formatHours(hours)}\n`;
    }
    ctx.reply(report);
  } else {
    ctx.reply('⚠️ For privacy, /allhours works only in private chat with the bot.');
  }
});

bot.command('allpay', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') {
    const users = listUsersFullStmt.all();
    if (!users.length) return ctx.reply('No users found.');

    let report = '💰 Weekly Pay (All Users):\n\n';
    for (const u of users) {
      const { hours, weekKey } = getWeekHours(u.user_id, nowUnix());
      const pay = weeklyPay(hours);
      const name = u.username
        ? '@' + u.username
        : (u.first_name || 'User ' + u.user_id);
      report += `${name}: ${usd(pay)} (${formatHours(hours)})\n`;
    }
    ctx.reply(report);
  } else {
    ctx.reply('⚠️ For privacy, /allpay works only in private chat with the bot.');
  }
});


// Start bot
console.log(">>> Starting Work Hours Bot...");
bot.launch().then(() => {
  console.log('Bot is up. Timezone:', dayjs.tz.guess());
  console.log('Auto weekly payout: Sunday 11:00 PM Asia/Manila');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
