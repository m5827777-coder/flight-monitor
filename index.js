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

// Total = 3 adults + 2 children × 75%
const PAXMULT = CFG.adults + CFG.children * 0.75; // 4.5

// ── Пляжные направления ТОЛЬКО ─────────────────────────────────────────────
const DESTINATIONS = [
  // Таиланд — пляжи
  { code: 'HKT', city: 'Пхукет',      country: 'Таиланд', beach: true },
  { code: 'USM', city: 'Самуи',        country: 'Таиланд', beach: true },
  { code: 'KBV', city: 'Краби',        country: 'Таиланд', beach: true },
  { code: 'HHQ', city: 'Хуахин',       country: 'Таиланд', beach: true },
  // Вьетнам — пляжи
  { code: 'DAD', city: 'Дананг',       country: 'Вьетнам', beach: true },
  { code: 'CXR', city: 'Нячанг',       country: 'Вьетнам', beach: true },
  { code: 'PQC', city: 'Фукуок',       country: 'Вьетнам', beach: true },
  { code: 'VCA', city: 'Фукуок (VCA)', country: 'Вьетнам', beach: true },
];

// ── Китайские хабы для поиска рейсов с пересадкой ─────────────────────────
// Travelpayouts не фильтрует по стране транзита,
// поэтому формируем отдельные ссылки Aviasales через China.
const CHINA_HUBS = [
  { code: 'PEK', city: 'Пекин'   },
  { code: 'PVG', city: 'Шанхай'  },
  { code: 'CAN', city: 'Гуанчжоу'},
  { code: 'CTU', city: 'Чэнду'   },
];

// ── State ──────────────────────────────────────────────────────────────────
const STATE = {
  startedAt:  new Date().toISOString(),
  lastCheck:  null,
  checks:     0,
  dealsFound: 0,
  errors:     0,
  running:    false,
  sentKeys:   new Set(),
};

// ── Logger ─────────────────────────────────────────────────────────────────
function log(msg, lvl = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${lvl.padEnd(5)}] ${msg}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Date helpers ───────────────────────────────────────────────────────────
function ruDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return [
    String(d.getDate()).padStart(2, '0'),
    String(d.getMonth() + 1).padStart(2, '0'),
    d.getFullYear(),
  ].join('.');
}

// dd+mm string for Aviasales URL, e.g. "1507"
function asDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0');
}

// ── Aviasales link builders ────────────────────────────────────────────────
// Direct / with any stopover — standard round-trip link
// Format: /search/MOW{ddmm}{DEST}{ddmm}{adults}{children_ages}
// Children ages encoded as separate suffix: e.g. "321" = 3 adults, 2 infants/children
// Simplest working format for 3 adults + 2 children (age 10):
function aviasalesLink(destCode, departIso, returnIso) {
  const dep = asDate(departIso);
  const ret = asDate(returnIso);
  if (!dep || !ret) return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}`;
  // 3 adults, 2 children age 10
  return `https://www.aviasales.ru/search/MOW${dep}${destCode}${ret}3?adults=3&children=2&infants=0`;
}

// Via China hub — open-jaw/multi-city link
function aviasalesChinaLink(destCode, hub, departIso, returnIso) {
  const dep = asDate(departIso);
  const ret = asDate(returnIso);
  if (!dep || !ret) return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}`;
  // MOW → hub → dest → MOW, shown as segment search
  return `https://www.aviasales.ru/search/MOW${dep}${hub}1${hub}${dep}${destCode}1${destCode}${ret}MOW1?adults=3&children=2`;
}

// General search link with China filter note (for Telegram)
function chinaSearchLink(destCode, departIso, returnIso) {
  const dep = asDate(departIso);
  const ret = asDate(returnIso);
  return `https://www.aviasales.ru/search/MOW${dep}${destCode}${ret}3?adults=3&children=2&stops=1`;
}

function stopsLabel(n) {
  if (n === 0)    return 'прямой ✈️';
  if (n === 1)    return '1 пересадка';
  if (n === 2)    return '2 пересадки';
  return `${n} пересадки`;
}

// ── Travelpayouts v2/prices/latest ─────────────────────────────────────────
async function fetchLatest(destCode) {
  const url = new URL('https://api.travelpayouts.com/v2/prices/latest');
  url.searchParams.set('currency',           'rub');
  url.searchParams.set('origin',             'MOW');
  url.searchParams.set('destination',        destCode);
  url.searchParams.set('period_type',        'year');
  url.searchParams.set('one_way',            'false');       // туда-обратно
  url.searchParams.set('show_to_affiliates', 'true');
  url.searchParams.set('sorting',            'price');
  url.searchParams.set('trip_class',         '0');           // эконом
  url.searchParams.set('min_trip_duration',  String(CFG.minDays));
  url.searchParams.set('max_trip_duration',  String(CFG.maxDays));
  url.searchParams.set('limit',              '30');
  url.searchParams.set('token',              CFG.tpToken);

  const r = await fetch(url.toString(), {
    headers: { 'Accept-Encoding': 'gzip, deflate' },
    signal:  AbortSignal.timeout(15000),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`TP ${r.status}: ${body.slice(0, 120)}`);
  }

  const json = await r.json();
  if (!json.success) throw new Error(`TP: ${json.error}`);
  return json.data || [];
}

// ── Collect all deals ──────────────────────────────────────────────────────
async function collectAll() {
  const all = [];

  for (const dest of DESTINATIONS) {
    try {
      const rows = await fetchLatest(dest.code);
      log(`  ${dest.code} (${dest.city}): ${rows.length} вариантов`);

      for (const r of rows) {
        const pricePerAdult = r.value || r.price;
        if (!pricePerAdult) continue;

        const departIso = r.departure_at || r.depart_date;
        const returnIso = r.return_at    || r.return_date;
        const transfers = r.number_of_changes ?? r.transfers ?? null;

        all.push({
          dest,
          pricePerAdult,
          totalRub:  Math.round(pricePerAdult * PAXMULT),
          days:      r.trip_duration || r.duration,
          departIso,
          returnIso,
          airline:   r.airline || '—',
          transfers,
          // ── Links ──────────────────────────────────────────────────────
          linkDirect: aviasalesLink(dest.code, departIso, returnIso),
          linkChina:  chinaSearchLink(dest.code, departIso, returnIso),
        });
      }
    } catch (e) {
      log(`  ${dest.code}: ${e.message}`, 'WARN');
    }
    await sleep(350);
  }

  return all.sort((a, b) => a.totalRub - b.totalRub);
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
    log('Telegram: отправлено');
  } catch (e) {
    log(`Telegram error: ${e.message}`, 'ERROR');
  }
}

// ── Hourly status (always sent) ────────────────────────────────────────────
function buildHourlyMsg(all, checkNum) {
  const now = new Date().toLocaleString('ru-RU');

  if (all.length === 0) {
    return (
      `📊 <b>Мониторинг #${checkNum}</b> · ${now}\n` +
      `✈️ Москва → пляжи Вьетнама и Таиланда\n` +
      `⚠️ Данных нет — Aviasales кэш пустой, попробуем позже`
    );
  }

  const best    = all[0];
  const inBudget = all.filter(d => d.totalRub <= CFG.maxPriceTotal);
  const icon     = inBudget.length > 0 ? '🟢 ЕСТЬ В БЮДЖЕТЕ!' : '🔴 пока дороже бюджета';
  const perPax   = Math.round(best.totalRub / (CFG.adults + CFG.children));

  let msg = `📊 <b>Мониторинг #${checkNum}</b> · ${now}\n`;
  msg += `✈️ Москва → 🏖 пляжи Вьетнама / Таиланда\n`;
  msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · туда-обратно · ${CFG.minDays}–${CFG.maxDays} дн\n`;
  msg += `💰 Бюджет: ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ · ${icon}\n`;
  msg += `──────────────────────\n`;

  // Minimum price block
  msg += `📉 <b>Минимум сейчас: ${best.totalRub.toLocaleString('ru-RU')} ₽</b>\n`;
  msg += `🏖 ${best.dest.city}, ${best.dest.country}\n`;
  if (best.departIso) {
    msg += `📅 ${ruDate(best.departIso)} → ${ruDate(best.returnIso)} (${best.days} дн.)\n`;
  }
  msg += `✈️ ${best.airline} · ${stopsLabel(best.transfers)}\n`;
  msg += `💵 ~${perPax.toLocaleString('ru-RU')} ₽/чел\n`;
  msg += `🛒 <a href="${best.linkDirect}">Купить на Aviasales</a>\n`;
  msg += `🇨🇳 <a href="${best.linkChina}">Искать с пересадкой в Китае</a>\n`;
  msg += `──────────────────────\n`;

  // Top cheapest by unique destination
  const byDest = new Map();
  for (const d of all) {
    if (!byDest.has(d.dest.code)) byDest.set(d.dest.code, d);
  }
  const top = [...byDest.values()].slice(0, 5);

  msg += `📋 <b>Топ направлений:</b>\n`;
  top.forEach((d, i) => {
    const pp   = Math.round(d.totalRub / (CFG.adults + CFG.children));
    const diff = d.totalRub - CFG.maxPriceTotal;
    const diffStr = diff <= 0
      ? `✅ -${Math.abs(diff).toLocaleString('ru-RU')} ₽ от бюджета`
      : `+${diff.toLocaleString('ru-RU')} ₽`;
    msg += `${i + 1}. 🏖 <b>${d.dest.city}</b> — `;
    msg += `${d.totalRub.toLocaleString('ru-RU')} ₽ (~${pp.toLocaleString('ru-RU')}/чел)`;
    msg += ` · ${diffStr}\n`;
    msg += `   🛒 <a href="${d.linkDirect}">Aviasales</a>`;
    msg += ` · 🇨🇳 <a href="${d.linkChina}">через Китай</a>\n`;
  });

  return msg;
}

// ── In-budget alert (only for new deals) ──────────────────────────────────
function buildAlertMsg(good) {
  const now = new Date().toLocaleString('ru-RU');
  let msg = `🔥 <b>БИЛЕТЫ В БЮДЖЕТЕ!</b> Aviasales · ${now}\n`;
  msg += `🏖 Москва → пляжи Вьетнама / Таиланда\n`;
  msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · до ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ на всех\n\n`;

  good.slice(0, 5).forEach((d, i) => {
    const pp = Math.round(d.totalRub / (CFG.adults + CFG.children));
    msg += `<b>${i + 1}. 🏖 ${d.dest.city}, ${d.dest.country}</b>\n`;
    if (d.departIso) {
      msg += `📅 ${ruDate(d.departIso)} → ${ruDate(d.returnIso)} (${d.days} дн.)\n`;
    }
    msg += `✈️ ${d.airline} · ${stopsLabel(d.transfers)}\n`;
    msg += `💰 <b>${d.totalRub.toLocaleString('ru-RU')} ₽</b> (~${pp.toLocaleString('ru-RU')} ₽/чел)\n`;
    msg += `🛒 <a href="${d.linkDirect}">Купить на Aviasales</a>\n`;
    msg += `🇨🇳 <a href="${d.linkChina}">Искать с пересадкой в Китае</a>\n\n`;
  });

  return msg;
}

// ── Main check ─────────────────────────────────────────────────────────────
async function runCheck() {
  if (STATE.running) { log('Skipped — still running', 'WARN'); return; }
  STATE.running = true;
  STATE.checks++;
  log(`=== Check #${STATE.checks} ===`);

  try {
    const all = await collectAll();
    STATE.lastCheck = new Date();
    log(`Итого: ${all.length} вариантов`);

    // 1. Hourly status — always
    await tg(buildHourlyMsg(all, STATE.checks));

    // 2. Alert — only for new in-budget deals
    const good = all.filter(d => d.totalRub <= CFG.maxPriceTotal);
    if (good.length > 0) {
      const newDeals = good.filter(d => {
        const key = `${d.dest.code}|${d.departIso}|${d.totalRub}`;
        if (STATE.sentKeys.has(key)) return false;
        STATE.sentKeys.add(key);
        if (STATE.sentKeys.size > 500) {
          STATE.sentKeys = new Set([...STATE.sentKeys].slice(-300));
        }
        return true;
      });

      if (newDeals.length > 0) {
        STATE.dealsFound += newDeals.length;
        log(`🎉 Новых предложений в бюджете: ${newDeals.length}`);
        await tg(buildAlertMsg(newDeals));
      }
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
      service:     'flight-monitor',
      status:      'ok',
      uptime_sec:  Math.floor(process.uptime()),
      startedAt:   STATE.startedAt,
      lastCheck:   STATE.lastCheck,
      checks:      STATE.checks,
      dealsFound:  STATE.dealsFound,
      errors:      STATE.errors,
      destinations: DESTINATIONS.map(d => `${d.code} ${d.city}`),
      config: {
        source:      'Aviasales горячие (v2/prices/latest)',
        tripType:    'туда-обратно',
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
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  Flight Monitor — пляжи VN/TH / Railway     ');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!CFG.tpToken)  { log('TRAVELPAYOUTS_TOKEN не задан', 'ERROR'); process.exit(1); }
  if (!CFG.botToken) { log('TELEGRAM_BOT_TOKEN не задан',  'ERROR'); process.exit(1); }
  if (!CFG.chatId)   { log('TELEGRAM_CHAT_ID не задан',    'ERROR'); process.exit(1); }

  log(`Направления : ${DESTINATIONS.map(d => `${d.code}(${d.city})`).join(', ')}`);
  log(`Бюджет      : ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ × ${PAXMULT} PAX`);
  log(`Тип рейса   : туда-обратно`);
  log(`Ночей       : ${CFG.minDays}–${CFG.maxDays}`);
  log(`Интервал    : ${CFG.intervalMin} мин`);

  startServer();

  await tg(
    `🚀 <b>Flight Monitor запущен</b>\n` +
    `🏖 Москва → пляжи Вьетнама и Таиланда\n` +
    `   Пхукет · Самуи · Краби · Хуахин\n` +
    `   Дананг · Нячанг · Фукуок\n` +
    `👨‍👩‍👧‍👦 3 взрослых + 2 детей · туда-обратно\n` +
    `📅 ${CFG.minDays}–${CFG.maxDays} дней\n` +
    `💰 Бюджет: ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ на всех\n` +
    `🇨🇳 Учитываем рейсы через Китай\n` +
    `🔄 Каждый час — отчёт с минимальной ценой\n` +
    `🔥 При попадании в бюджет — отдельный алерт\n` +
    `⏰ ${new Date().toLocaleString('ru-RU')}`
  );

  await runCheck();
  setInterval(runCheck, CFG.intervalMin * 60 * 1000);
}

main().catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
