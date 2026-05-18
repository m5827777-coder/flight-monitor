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
  children:      2,
  minDays:       12,
  maxDays:       16,
};

// Price from API = per 1 adult (economy).
// Total = adults × price + children × price × 0.75
const PAXMULT = CFG.adults + CFG.children * 0.75; // 4.5

// Destinations to scan
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
  startedAt:    new Date().toISOString(),
  lastCheck:    null,
  checks:       0,
  dealsFound:   0,
  errors:       0,
  running:      false,
  // track seen deals to avoid duplicate Telegram spam
  sentKeys:     new Set(),
};

// ── Logger ─────────────────────────────────────────────────────────────────
function log(msg, lvl = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${lvl.padEnd(5)}] ${msg}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ── Format date dd.mm.yyyy ─────────────────────────────────────────────────
function ruDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return [
    String(d.getDate()).padStart(2, '0'),
    String(d.getMonth() + 1).padStart(2, '0'),
    d.getFullYear(),
  ].join('.');
}

// ── Build Aviasales search link ────────────────────────────────────────────
function aviasalesLink(dest, departIso, returnIso) {
  const fmt = iso => {
    const d = new Date(iso);
    return String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0');
  };
  // e.g. https://www.aviasales.ru/search/MOW1507HKT2207
  return `https://www.aviasales.ru/search/MOW${fmt(departIso)}${dest}${fmt(returnIso)}1`;
}

// ── Travelpayouts v2/prices/latest ─────────────────────────────────────────
// This is the "горячие билеты" feed — cheapest tickets found by real
// Aviasales users in the last 48 hours, filterable by trip duration.
// Price returned = per 1 adult (economy). We multiply by PAXMULT.
// Docs: https://travelpayouts.github.io/slate/#the-prices-for-the-airline-tickets
// ──────────────────────────────────────────────────────────────────────────
async function fetchLatest(destCode) {
  const url = new URL('https://api.travelpayouts.com/v2/prices/latest');
  url.searchParams.set('currency',          'rub');
  url.searchParams.set('origin',            'MOW');
  url.searchParams.set('destination',       destCode);
  url.searchParams.set('period_type',       'year');       // search across whole year
  url.searchParams.set('one_way',           'false');      // round-trip only
  url.searchParams.set('show_to_affiliates','true');       // include all affiliate prices
  url.searchParams.set('sorting',           'price');      // cheapest first
  url.searchParams.set('trip_class',        '0');          // economy
  url.searchParams.set('min_trip_duration', String(CFG.minDays));
  url.searchParams.set('max_trip_duration', String(CFG.maxDays));
  url.searchParams.set('limit',             '30');
  url.searchParams.set('page',              '1');
  url.searchParams.set('token',             CFG.tpToken);

  const r = await fetch(url.toString(), {
    headers: { 'Accept-Encoding': 'gzip, deflate' },
    signal:  AbortSignal.timeout(15000),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`TP API ${r.status}: ${body.slice(0, 150)}`);
  }

  const json = await r.json();
  if (!json.success) throw new Error(`TP API error: ${json.error}`);
  return json.data || [];
}

// ── Main check ─────────────────────────────────────────────────────────────
async function runCheck() {
  if (STATE.running) { log('Skipped — still running', 'WARN'); return; }
  STATE.running = true;
  STATE.checks++;
  log(`=== Check #${STATE.checks} — горячие билеты Aviasales ===`);

  try {
    const allDeals = [];

    for (const dest of DESTINATIONS) {
      try {
        const rows = await fetchLatest(dest.code);
        log(`  ${dest.code}: ${rows.length} вариантов из кэша`);

        for (const r of rows) {
          const pricePerAdult = r.value || r.price;
          if (!pricePerAdult) continue;

          const totalRub  = Math.round(pricePerAdult * PAXMULT);
          const days      = r.trip_duration || r.duration;
          const departIso = r.departure_at  || r.depart_date;
          const returnIso = r.return_at     || r.return_date;

          allDeals.push({
            dest,
            pricePerAdult,
            totalRub,
            days,
            departIso,
            returnIso,
            airline:   r.airline    || '—',
            transfers: r.number_of_changes ?? r.transfers ?? '?',
            link:      r.ticket_link
              ? `https://www.aviasales.ru/search/${r.ticket_link}`
              : aviasalesLink(dest.code, departIso, returnIso),
          });
        }
      } catch (e) {
        log(`  ${dest.code}: ${e.message}`, 'WARN');
      }

      await sleep(350); // be polite to the API
    }

    STATE.lastCheck = new Date();
    log(`Всего собрано: ${allDeals.length} вариантов`);

    // Filter to budget
    const good = allDeals
      .filter(d => d.totalRub > 0 && d.totalRub <= CFG.maxPriceTotal)
      .sort((a, b) => a.totalRub - b.totalRub);

    log(`В бюджете ≤ ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽: ${good.length}`);

    // ── New deals in budget ───────────────────────────────────────────────
    if (good.length > 0) {
      // Deduplicate: only send truly new deals (by dest+depart+price)
      const newDeals = good.filter(d => {
        const key = `${d.dest.code}|${d.departIso}|${d.totalRub}`;
        if (STATE.sentKeys.has(key)) return false;
        STATE.sentKeys.add(key);
        if (STATE.sentKeys.size > 500) {
          // trim old keys to avoid memory leak
          const arr = [...STATE.sentKeys];
          STATE.sentKeys = new Set(arr.slice(-300));
        }
        return true;
      });

      if (newDeals.length > 0) {
        STATE.dealsFound += newDeals.length;
        log(`Новых предложений: ${newDeals.length} — отправляю в Telegram`);

        let msg = `🔥 <b>ГОРЯЧИЕ БИЛЕТЫ В БЮДЖЕТЕ! (Aviasales)</b>\n`;
        msg += `✈️ Москва → Вьетнам / Таиланд\n`;
        msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · ${CFG.minDays}–${CFG.maxDays} дн · до ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽\n\n`;

        newDeals.slice(0, 5).forEach((d, i) => {
          const stops = d.transfers === 0 ? 'прямой' : `${d.transfers} пересадка(и)`;
          const perPax = Math.round(d.totalRub / (CFG.adults + CFG.children));
          msg += `<b>${i + 1}. ${d.dest.city}, ${d.dest.country}</b>\n`;
          if (d.departIso) msg += `📅 ${ruDate(d.departIso)} → ${ruDate(d.returnIso)} (${d.days} дн.)\n`;
          msg += `✈️ ${d.airline} · ${stops}\n`;
          msg += `💰 <b>${d.totalRub.toLocaleString('ru-RU')} ₽</b> (~${perPax.toLocaleString('ru-RU')} ₽/чел)\n`;
          msg += `🔗 ${d.link}\n\n`;
        });

        msg += `⏰ ${new Date().toLocaleString('ru-RU')}`;
        await tg(msg);

      } else {
        log('Все варианты в бюджете уже были отправлены ранее — пропускаю');
      }

    // ── Nothing in budget — send cheapest as status update ────────────────
    } else if (allDeals.length > 0) {
      const best = allDeals.sort((a, b) => a.totalRub - b.totalRub)[0];
      const stops = best.transfers === 0 ? 'прямой' : `${best.transfers} пер.`;
      log(`Дешевле всего: ${best.totalRub.toLocaleString('ru-RU')} ₽ → ${best.dest.city}`);

      // Status update every check (not deduplicated — user wants to know the trend)
      await tg(
        `📊 <b>Мониторинг #${STATE.checks}</b> · Aviasales горячие\n` +
        `Вариантов найдено: ${allDeals.length} — все дороже бюджета\n\n` +
        `Ближайшее к бюджету:\n` +
        `<b>${best.dest.city}, ${best.dest.country}</b> · ${stops}\n` +
        (best.departIso ? `📅 ${ruDate(best.departIso)} → ${ruDate(best.returnIso)} (${best.days} дн.)\n` : '') +
        `✈️ ${best.airline}\n` +
        `💰 ${best.totalRub.toLocaleString('ru-RU')} ₽ · бюджет ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽\n` +
        `   (разница: +${(best.totalRub - CFG.maxPriceTotal).toLocaleString('ru-RU')} ₽)\n` +
        `🔗 ${best.link}\n\n` +
        `⏰ ${new Date().toLocaleString('ru-RU')}`
      );

    } else {
      log('Кэш пустой — Aviasales ещё не накопил данные по этим маршрутам');
    }

  } catch (e) {
    STATE.errors++;
    log(`Check error: ${e.message}`, 'ERROR');
    if (STATE.errors <= 2 || STATE.errors % 5 === 0) {
      await tg(`⚠️ <b>Ошибка мониторинга</b>\n<code>${e.message.slice(0, 300)}</code>`);
    }
  } finally {
    STATE.running = false;
    log(`=== Check #${STATE.checks} завершён ===`);
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
      startedAt:  STATE.startedAt,
      lastCheck:  STATE.lastCheck,
      checks:     STATE.checks,
      dealsFound: STATE.dealsFound,
      errors:     STATE.errors,
      config: {
        source:      'Aviasales горячие билеты (v2/prices/latest)',
        maxPrice:    CFG.maxPriceTotal,
        passengers:  `${CFG.adults} взр + ${CFG.children} дет (×${PAXMULT})`,
        nights:      `${CFG.minDays}–${CFG.maxDays}`,
        intervalMin: CFG.intervalMin,
      },
    }, null, 2));
  }).listen(CFG.port, () => log(`Health server :${CFG.port}`));
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  Flight Monitor — Aviasales горячие / Railway ');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!CFG.tpToken)  { log('TRAVELPAYOUTS_TOKEN не задан — выход', 'ERROR'); process.exit(1); }
  if (!CFG.botToken) { log('TELEGRAM_BOT_TOKEN не задан — выход',  'ERROR'); process.exit(1); }
  if (!CFG.chatId)   { log('TELEGRAM_CHAT_ID не задан — выход',    'ERROR'); process.exit(1); }

  log(`TP token    : ✓`);
  log(`TG token    : ✓`);
  log(`Chat ID     : ✓`);
  log(`Бюджет      : ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ на ${CFG.adults} взр + ${CFG.children} дет (множитель ×${PAXMULT})`);
  log(`Интервал    : каждые ${CFG.intervalMin} мин`);
  log(`Длительность: ${CFG.minDays}–${CFG.maxDays} ночей`);
  log(`Направления : ${DESTINATIONS.map(d => d.code).join(', ')}`);
  log(`Источник    : Aviasales v2/prices/latest (горячие билеты, кэш 48ч)`);

  startServer();

  await tg(
    `🚀 <b>Flight Monitor запущен</b>\n` +
    `📡 Источник: Aviasales горячие билеты\n` +
    `✈️ Москва → Вьетнам (HAN/SGN/DAD) / Таиланд (BKK/HKT/DMK)\n` +
    `👨‍👩‍👧‍👦 3 взрослых + 2 детей · ${CFG.minDays}–${CFG.maxDays} дней\n` +
    `💰 До ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ на всех\n` +
    `🔄 Проверка каждые ${CFG.intervalMin} мин\n` +
    `⏰ ${new Date().toLocaleString('ru-RU')}`
  );

  await runCheck();
  setInterval(runCheck, CFG.intervalMin * 60 * 1000);
}

main().catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
