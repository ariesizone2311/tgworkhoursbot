// Work Hours Tracker — Cloudflare Workers + KV
// Commands: /in /out /today /week /pay /help
// Weekly cron: Sunday 23:00 UTC -> sends previous local week summary + CSV, then clears it
// KV: HOURS
// ENV: BOT_TOKEN, SECRET_TOKEN
// Optional ENV: TZ_OFFSET (hours, default 0), PAY_RATE (USD/hr, default 2.5), ADMIN_SECRET (for test URL)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health + admin test route
    if (request.method === "GET") {
      if (url.pathname === "/") return new Response("OK");
      if (url.pathname === "/admin/run-weekly") {
        const ok = (env.ADMIN_SECRET || "") && url.searchParams.get("secret") === env.ADMIN_SECRET;
        if (!ok) return new Response("unauthorized", { status: 401 });
        await runWeekly(env); // run job now (for testing)
        return new Response("weekly ok");
      }
      return new Response("not found", { status: 404 });
    }

    // Telegram webhook
    if (request.method === "POST" && url.pathname === `/${env.BOT_TOKEN}`) {
      const secret = request.headers.get("x-telegram-bot-api-secret-token") || "";
      if (secret !== env.SECRET_TOKEN) return new Response("unauthorized", { status: 401 });

      const update = await request.json();
      const msg = update.message;
      if (!msg?.text) return ok();

      const text   = msg.text.trim();
      const chatId = msg.chat.id;
      const userId = String(msg.from?.id || chatId);

      // Remember chats to notify on weekly job
      await ensureUserChat(env, userId, chatId);

      // Group-friendly parsing: accept "/in@YourBot"
      const firstToken = text.split(/\s+/)[0];
      const baseCmd    = firstToken.split("@")[0].toLowerCase();

      if (baseCmd === "/ping")  { await sendMessage(env, chatId, "pong ✅"); return ok(); }
      if (baseCmd === "/help")  { await sendMessage(env, chatId, helpText(env)); return ok(); }
      if (baseCmd === "/in"   || baseCmd === "/clock") { await cmdIn(env, chatId, userId); return ok(); }
      if (baseCmd === "/out")   { await cmdOut(env, chatId, userId); return ok(); }
      if (baseCmd === "/today") { await cmdToday(env, chatId, userId); return ok(); }
      if (baseCmd === "/week")  { await cmdWeek(env, chatId, userId); return ok(); }
      if (baseCmd === "/pay")   { await cmdPay(env, chatId, userId); return ok(); }

      await sendMessage(env, chatId, "Unknown command.\n" + helpText(env));
      return ok();
    }

    return new Response("not found", { status: 404 });
  },

  // CRON: add "0 23 * * SUN" in Cloudflare → Settings → Triggers
  async scheduled(controller, env, ctx) {
    // simple lock so the job doesn’t double-run
    const { localMs } = nowLocal(env);
    const { start } = prevLocalWeekWindow(env, localMs); // Monday 00:00 (local) of the previous week
    const lockKey = "weeklylock:" + dateKeyLocal(env, start);
    if (await env.HOURS.get(lockKey)) return;
    await env.HOURS.put(lockKey, "1", { expirationTtl: 3 * 3600 }); // 3h lock
    ctx.waitUntil(runWeekly(env));
  }
};

function ok() { return new Response("ok"); }

/* -------------------- Config & time helpers -------------------- */
function tzOffsetHours(env) { const n = Number(env.TZ_OFFSET); return Number.isFinite(n) ? n : 0; }
function rate(env)         { const r = Number(env.PAY_RATE);   return Number.isFinite(r) ? r : 2.5; }
function nowLocal(env)     { const off = tzOffsetHours(env); const utc = Date.now(); return { utcMs: utc, localMs: utc + off * 3600_000 }; }

function fmtHM(ms) {
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  return `${h}h ${m}m`;
}
function minutes(ms){ return Math.max(0, Math.floor(ms/60000)); }
function dollarsFromMs(ms, r){ return (ms/3600000) * r; }
function money(v){ return `$${v.toFixed(2)}`; }
function fmtClock(ms){
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2,"0");
  const mm = String(d.getUTCMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}

function dateKeyLocal(env, localMs){
  const d = new Date(localMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const da= String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}
// Monday start of week in *local* time (computed via TZ offset)
function weekStartLocal(env, localMs){
  const d = new Date(localMs);
  const dow = (d.getUTCDay() + 6) % 7; // 0..6, 0=Mon
  const start = new Date(d.getTime() - dow*86400_000);
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
}
// The fully-completed previous local week [Mon..Sun]
function prevLocalWeekWindow(env, localMs){
  // Anchor 12h back so if cron runs around boundary we're inside the previous week
  const anchor = localMs - 12*3600_000;
  const start = weekStartLocal(env, anchor);        // Mon 00:00 local (UTC ms)
  const end   = start + 7*86400_000;                // next Mon 00:00 local
  return { start, end };
}

/* -------------------- KV keys & helpers -------------------- */
const kOpen = (u) => `u:${u}:open`;            // { startUtcMs }
const kDay  = (u, day) => `d:${u}:${day}`;     // { sessions:[{inUtcMs,outUtcMs?}], totalMs }
const kMeta = (u) => `meta:${u}`;              // { chats:number[] }

async function getJSON(kv, key, def){ const s = await kv.get(key); return s ? JSON.parse(s) : def; }
async function putJSON(kv, key, obj){ await kv.put(key, JSON.stringify(obj)); }
async function getOpen(env, userId){ return getJSON(env.HOURS, kOpen(userId), null); }
async function ensureUserChat(env, userId, chatId){
  const m = await getJSON(env.HOURS, kMeta(userId), { chats: [] });
  if (!m.chats.includes(chatId)) { m.chats.push(chatId); await putJSON(env.HOURS, kMeta(userId), m); }
}

/* -------------------- Throttle + Telegram helpers -------------------- */
// keep replies ≥1.1s apart per chat and retry once on 429/5xx
const kThrottle = (cid) => `throttle:${cid}`;
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function throttlePerChat(env, chat_id){
  const now = Date.now();
  const key = kThrottle(chat_id);
  const last = Number(await env.HOURS.get(key)) || 0;
  const wait = 1100 - (now - last);
  if (wait > 0 && wait < 5000) await sleep(wait);
  await env.HOURS.put(key, String(Date.now()), { expirationTtl: 3600 });
}
async function tgCall(env, method, body, isForm = false){
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const opts = { method: "POST", headers: isForm ? undefined : { "content-type": "application/json" }, body: isForm ? body : JSON.stringify(body) };
  let res = await fetch(url, opts);
  let data; try { data = await res.json(); } catch { data = {}; }
  const needsRetry = (data && data.ok === false && data.error_code === 429) || (!res.ok && res.status >= 500);
  if (needsRetry) {
    const retryAfter = (data?.parameters?.retry_after ?? 1) * 1000;
    await sleep(Math.min(retryAfter, 2000));
    res = await fetch(url, opts);
    try { data = await res.json(); } catch { data = {}; }
  }
  return data;
}
async function sendMessage(env, chat_id, text){
  await throttlePerChat(env, chat_id);
  return tgCall(env, "sendMessage", { chat_id, text });
}
async function sendDocument(env, chat_id, filename, content, mime = "text/csv"){
  await throttlePerChat(env, chat_id);
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("document", new File([content], filename, { type: mime }));
  return tgCall(env, "sendDocument", fd, true);
}

/* -------------------- Commands -------------------- */
// put this helper just above helpText
function pad2(n){ return String(n).padStart(2, "0"); }

// REPLACE your existing helpText with this
function helpText(env){
  const r = rate(env).toFixed(2);

  // local offset (e.g., CET = +1)
  const off = tzOffsetHours(env);
  const offLabel = `UTC${off >= 0 ? `+${off}` : off}`;

  // We fire at 23:59 LOCAL every Sunday.
  // Convert that to the equivalent UTC time for display.
  let utcHour = (23 - off) % 24; if (utcHour < 0) utcHour += 24;
  const utcStr = `${pad2(utcHour)}:59 UTC`;

  return [
    "⏱ Work Hours Bot",
    "/in — clock in",
    "/out — clock out",
    "/today — show today’s total",
    "/week — show this week’s total (hours + minutes + pay)",
    "/pay — show this week’s pay",
    `/help — show this help (rate: $${r}/hr)`,
    `Auto: Sunday 23:59 ${offLabel} (= ${utcStr}) → sends pay + CSV, then resets last week.`
  ].join("\n");
}


async function cmdIn(env, chatId, userId){
  const open = await getOpen(env, userId);
  const { utcMs, localMs } = nowLocal(env);
  if (open?.startUtcMs) {
    const startedLocal = open.startUtcMs + tzOffsetHours(env)*3600_000;
    return sendMessage(env, chatId, `You are already clocked IN since ${fmtClock(startedLocal)}. Use /out to clock out.`);
  }
  await putJSON(env.HOURS, kOpen(userId), { startUtcMs: utcMs });
  const dayKey = dateKeyLocal(env, localMs);
  const rec = await getJSON(env.HOURS, kDay(userId, dayKey), { sessions: [], totalMs: 0 });
  rec.sessions.push({ inUtcMs: utcMs });
  await putJSON(env.HOURS, kDay(userId, dayKey), rec);
  return sendMessage(env, chatId, `Clocked IN at ${fmtClock(localMs)}.`);
}

async function cmdOut(env, chatId, userId){
  const open = await getOpen(env, userId);
  if (!open?.startUtcMs) return sendMessage(env, chatId, "You are not clocked IN. Use /in to start.");
  const { utcMs, localMs } = nowLocal(env);
  const delta = utcMs - open.startUtcMs;

  const dayKey = dateKeyLocal(env, localMs);
  const key = kDay(userId, dayKey);
  const rec = await getJSON(env.HOURS, key, { sessions: [], totalMs: 0 });
  for (let i = rec.sessions.length - 1; i >= 0; i--) {
    if (rec.sessions[i].outUtcMs == null) { rec.sessions[i].outUtcMs = utcMs; break; }
  }
  rec.totalMs = (rec.totalMs || 0) + delta;
  await putJSON(env.HOURS, key, rec);
  await env.HOURS.delete(kOpen(userId));

  return sendMessage(env, chatId, `Clocked OUT at ${fmtClock(localMs)}.\nSession: ${fmtHM(delta)}\nToday so far: ${fmtHM(rec.totalMs)}`);
}

async function cmdToday(env, chatId, userId){
  const { utcMs, localMs } = nowLocal(env);
  const dayKey = dateKeyLocal(env, localMs);
  const rec = await getJSON(env.HOURS, kDay(userId, dayKey), null);
  let total = rec?.totalMs || 0;
  const open = await getOpen(env, userId);
  if (open?.startUtcMs) total += utcMs - open.startUtcMs;
  return sendMessage(env, chatId, `Today: ${fmtHM(total)} (${minutes(total)} mins)`);
}

async function cmdWeek(env, chatId, userId){
  const { utcMs, localMs } = nowLocal(env);
  const todayKey = dateKeyLocal(env, localMs);
  const start = weekStartLocal(env, localMs);
  let total = 0, lines = [];
  for (let i = 0; i < 7; i++) {
    const dayMs = start + i*86400_000;
    const keyDay = dateKeyLocal(env, dayMs);
    let t = (await getJSON(env.HOURS, kDay(userId, keyDay), null))?.totalMs || 0;
    if (keyDay === todayKey) { const open = await getOpen(env, userId); if (open?.startUtcMs) t += utcMs - open.startUtcMs; }
    total += t; lines.push(`${keyDay}: ${fmtHM(t)}`);
  }
  const mins = minutes(total), pay = money(dollarsFromMs(total, rate(env)));
  return sendMessage(env, chatId, `This week: ${fmtHM(total)} (${mins} mins)\nPay @ $${rate(env).toFixed(2)}/hr: ${pay}\n` + lines.join("\n"));
}

async function cmdPay(env, chatId, userId){
  const { utcMs, localMs } = nowLocal(env);
  const todayKey = dateKeyLocal(env, localMs);
  const start = weekStartLocal(env, localMs);
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const dayMs = start + i*86400_000;
    const keyDay = dateKeyLocal(env, dayMs);
    let t = (await getJSON(env.HOURS, kDay(userId, keyDay), null))?.totalMs || 0;
    if (keyDay === todayKey) { const open = await getOpen(env, userId); if (open?.startUtcMs) t += utcMs - open.startUtcMs; }
    total += t;
  }
  const mins = minutes(total), pay = money(dollarsFromMs(total, rate(env)));
  return sendMessage(env, chatId, `Week total: ${fmtHM(total)} (${mins} mins)\nPay @ $${rate(env).toFixed(2)}/hr: ${pay}`);
}

/* -------------------- Weekly runner (cron + admin) -------------------- */
async function runWeekly(env){
  const { utcMs, localMs } = nowLocal(env);
  const { start, end } = prevLocalWeekWindow(env, localMs); // completed local week

  // iterate all users that interacted (meta:*). handle pagination just in case.
  let cursor = undefined;
  do {
    const list = await env.HOURS.list({ prefix: "meta:", cursor });
    for (const item of list.keys) {
      const userId = item.name.split(":")[1];
      const meta = await getJSON(env.HOURS, item.name, { chats: [] });
      if (!meta.chats.length) continue;

      // Sum the week + build CSV (Date,Sessions,Total,Minutes)
      let total = 0;
      const rows = [["Date","Sessions","Total (h:m)","Minutes"]];
      for (let i = 0; i < 7; i++) {
        const dayMs = start + i*86400_000;
        const dayKey = dateKeyLocal(env, dayMs);
        const rec = await getJSON(env.HOURS, kDay(userId, dayKey), null);
        const t = rec?.totalMs || 0;
        total += t;
        rows.push([dayKey, String(rec?.sessions?.length || 0), fmtHM(t), String(minutes(t))]);
      }
      // include any running session up to end of week
      const open = await getOpen(env, userId);
      if (open?.startUtcMs) {
        const extra = Math.max(0, Math.min(utcMs, end) - open.startUtcMs);
        if (extra > 0) {
          total += extra;
          const lastIdx = rows.length - 1;
          // add note by appending "(+running)" to last row total
          rows[lastIdx][2] = rows[lastIdx][2] + " (+running)";
        }
      }

      const mins = minutes(total);
      const pay  = money(dollarsFromMs(total, rate(env)));
      const summary = `Weekly summary (last local week)\nTotal: ${fmtHM(total)} (${mins} mins)\nPay @ $${rate(env).toFixed(2)}/hr: ${pay}\n\n✅ Reset for new week.`;

      // CSV
      const csv = rows.map(r => r.map(x => {
        const s = String(x);
        return s.includes(",") ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(",")).join("\n");
      const fname = `workweek_${dateKeyLocal(env, start)}.csv`;

      // Send to all chats this user used
      for (const chatId of meta.chats) {
        await sendMessage(env, chatId, summary);
        await sendDocument(env, chatId, fname, csv, "text/csv");
      }

      // Clear last week’s data for this user
      await deleteWeekRange(env, userId, start, end);
    }
    cursor = list.cursor;
  } while (cursor);
}

async function deleteWeekRange(env, userId, startUtcMs, endUtcMs){
  // delete Mon..Sun local day keys and any open flag
  for (let ms = startUtcMs; ms < endUtcMs; ms += 86400_000) {
    const dayKey = dateKeyLocal(env, ms);
    await env.HOURS.delete(kDay(userId, dayKey));
  }
  await env.HOURS.delete(kOpen(userId));
}
