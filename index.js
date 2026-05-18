'use strict';

const http = require('http');

// ── Config ─────────────────────────────────────────────────────────────────
const CFG = {
  tpToken:       process.env.TRAVELPAYOUTS_TOKEN,
  botToken:      process.env.TELEGRAM_BOT_TOKEN,
  chatId:        process.env.TELEGRAM_CHAT_ID,
  maxPriceTotal: parseInt(process.env.MAX_PRICE              || '150000'),
  intervalMin:   parseInt(process.env.CHECK_INTERVAL_MINUTES || '60'),
  port:          parseInt(process.env.PORT                   || '3000'),
  adults:        3,
  children:      2,   // ~75% of adult price each on intl routes
  minDays:       12,
  maxDays:       16,
};

// Price multiplier: 3 adults + 2 children (75%)
const PAXMULT = CFG.adults + CFG.children * 0.75; // = 4.5

const DESTINATIONS = [
  { code: 'HAN', city: 'Ханой',         country: 'Вьетнам' },
  { code: 'SGN', city: 'Хошимин',       country: 'Вьетнам' },
  { code: 'DAD', city: 'Дананг',        country: 'Вьетнам' },
  { code: 'BKK', city: 'Бангкок',       country: 'Таиланд' },
  { code: 'HKT', city: 'Пхукет',        country: 'Таиланд' },
  { code: 'DMK', city: 'Бангкок (DMK)', country: 'Таиланд' },
];

// ── State ──────────────────────────────────────────────────────────────────
const STATE = {
  startedAt:  new Date().toISOString(),
  lastCheck:  null,
  checks:     0,
  dealsFound: 0,
  errors:     0,
  running:    false,
};

// ── Logger ─────────────────────────────────────────────────────────────────
function log(msg, lvl = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${lvl.padEnd(5)}] ${msg}`);
}

// ── Telegram ───────────────────────────────────────────────────────────────
async function tg(text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CFG.chatId, text, parse_mode: 'HTML' }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.description);
    log('Telegram: sent');
    return true;
  } catch (e) {
    log(`Telegram error: ${e.message}`, 'ERROR');
    return false;
  }
}

// ── Travelpayouts cheapest prices for a month ──────────────────────────────
async function fetchCheapest(dest, yearMonth) {
  const url = new URL('https://api.travelpayouts.com/v1/prices/cheap');
  url.searchParams.set('origin',      'MOW');
  url.searchParams.set('destination', dest.code);
  url.searchParams.set('depart_date', yearMonth);
  url.searchParams.set('return_date', yearMonth);
  url.searchParams.set('currency',    'rub');
  url.searchParams.set('token',       CFG.tpToken);

  const r = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`TP API ${r.status} for ${dest.code}`);
  const json = await r.json();

  if (!json.success || !json.data || !json.data[dest.code]) return [];

  const results = [];

  for (const [, info] of Object.entries(json.data[dest.code])) {
    if (!info.depart_date || !info.return_date) continue;

    const dep  = new Date(info.depart_date);
    const ret  = new Date(info.return_date);
    const days = Math.round((ret - dep) / 864e5);

    if (days < CFG.minDays || days > CFG.maxDays) continue;

    const pricePerAdult = info.price;
    const totalRub      = Math.round(pricePerAdult * PAXMULT);

    results.push({
      dest,
      depart:        info.depart_date,
      ret:           info.return_date,
      days,
      pricePerAdult,
      totalRub,
      airline:       info.airline || '—',
      stops:         info.transfers === 0 ? 'без пересадок' : `${info.transfers} пересадка(и)`,
      url: `https://www.aviasales.ru/search/MOW${fmtDate(dep)}${dest.code}${fmtDate(ret)}1`,
    });
  }

  return results;
}

function fmtDate(d) {
  return String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0');
}

function getMonths() {
  const months = [];
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main check ─────────────────────────────────────────────────────────────
async function runCheck() {
  if (STATE.running) { log('Skipped — still running', 'WARN'); return; }
  STATE.running = true;
  STATE.checks++;
  log(`=== Check #${STATE.checks} ===`);

  try {
    const months   = getMonths();
    const allDeals = [];

    for (const dest of DESTINATIONS) {
      for (const month of months) {
        try {
          const rows = await fetchCheapest(dest, month);
          allDeals.push(...rows);
          log(`  ${dest.code} ${month}: ${rows.length} variants`);
        } catch (e) {
          log(`  ${dest.code} ${month}: ${e.message}`, 'WARN');
        }
        await sleep(400);
      }
    }

    STATE.lastCheck = new Date();

    const good = allDeals
      .filter(d => d.totalRub <= CFG.maxPriceTotal)
      .sort((a, b) => a.totalRub - b.totalRub);

    log(`Total: ${allDeals.length} variants, ${good.length} in budget`);

    if (good.length > 0) {
      STATE.dealsFound += good.length;

      let msg = `🎉 <b>БИЛЕТЫ В БЮДЖЕТЕ!</b>\n`;
      msg += `✈️ Москва → Вьетнам / Таиланд\n`;
      msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · ${CFG.minDays}–${CFG.maxDays} дн · до ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽\n\n`;

      good.slice(0, 4).forEach((d, i) => {
        msg += `<b>${i + 1}. ${d.dest.city} (${d.dest.country})</b>\n`;
        msg += `📅 ${d.depart} → ${d.ret} (${d.days} дн.) · ${d.stops}\n`;
        msg += `✈️ ${d.airline}\n`;
        msg += `💰 <b>${d.totalRub.toLocaleString('ru-RU')} ₽</b> (~${Math.round(d.pricePerAdult).toLocaleString('ru-RU')} ₽/взр)\n`;
        msg += `🔗 ${d.url}\n\n`;
      });

      msg += `⏰ ${new Date().toLocaleString('ru-RU')}`;
      await tg(msg);

    } else if (allDeals.length > 0) {
      const best = allDeals.sort((a, b) => a.totalRub - b.totalRub)[0];
      log(`Cheapest: ${best.totalRub.toLocaleString('ru-RU')} ₽ → ${best.dest.city}`);

      await tg(
        `📊 <b>Мониторинг #${STATE.checks}</b>\n` +
        `Найдено вариантов: ${allDeals.length} — все дороже бюджета\n\n` +
        `Самое дешёвое:\n` +
        `<b>${best.dest.city}, ${best.dest.country}</b> · ${best.depart} → ${best.ret} (${best.days} дн.)\n` +
        `💰 ${best.totalRub.toLocaleString('ru-RU')} ₽ (бюджет ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽)\n` +
        `🔗 ${best.url}\n\n` +
        `⏰ ${new Date().toLocaleString('ru-RU')}`
      );
    } else {
      log('No data returned this round');
    }

  } catch (e) {
    STATE.errors++;
    log(`Check error: ${e.message}`, 'ERROR');
    if (STATE.errors <= 2 || STATE.errors % 5 === 0) {
      await tg(`⚠️ <b>Ошибка мониторинга</b>\n<code>${e.message.slice(0, 200)}</code>`);
    }
  } finally {
    STATE.running = false;
    log(`=== Check #${STATE.checks} done ===`);
  }
}

// ── Health HTTP ────────────────────────────────────────────────────────────
function startServer() {
  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service:    'flight-monitor',
      status:     'ok',
      uptime_sec: Math.floor(process.uptime()),
      ...STATE,
      config: { maxPriceTotal: CFG.maxPriceTotal, intervalMin: CFG.intervalMin },
    }, null, 2));
  }).listen(CFG.port, () => log(`Health server :${CFG.port}`));
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  Flight Monitor — Railway Worker    ');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!CFG.tpToken)  { log('TRAVELPAYOUTS_TOKEN not set — exiting', 'ERROR'); process.exit(1); }
  if (!CFG.botToken) { log('TELEGRAM_BOT_TOKEN not set — exiting',  'ERROR'); process.exit(1); }
  if (!CFG.chatId)   { log('TELEGRAM_CHAT_ID not set — exiting',    'ERROR'); process.exit(1); }

  log(`TP token  : ✓ set`);
  log(`TG token  : ✓ set`);
  log(`Chat ID   : ✓ set`);
  log(`Budget    : ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ × ${PAXMULT} PAX`);
  log(`Interval  : ${CFG.intervalMin} min`);
  log(`Duration  : ${CFG.minDays}–${CFG.maxDays} days`);

  startServer();

  await tg(
    `🚀 <b>Flight Monitor запущен</b>\n` +
    `✈️ Москва → Вьетнам / Таиланд\n` +
    `👨‍👩‍👧‍👦 3 взрослых + 2 детей · ${CFG.minDays}–${CFG.maxDays} дней\n` +
    `💰 До ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ на всех\n` +
    `🔄 Проверка каждые ${CFG.intervalMin} мин\n` +
    `⏰ ${new Date().toLocaleString('ru-RU')}`
  );

  await runCheck();
  setInterval(runCheck, CFG.intervalMin * 60 * 1000);
}

main().catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
