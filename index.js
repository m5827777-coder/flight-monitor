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

// 3 взрослых + 2 детей × 75% от взрослого
const PAXMULT = CFG.adults + CFG.children * 0.75; // 4.5

// Пляжные направления
const DESTINATIONS = [
  { code: 'HKT', city: 'Пхукет',  country: 'Таиланд' },
  { code: 'USM', city: 'Самуи',   country: 'Таиланд' },
  { code: 'KBV', city: 'Краби',   country: 'Таиланд' },
  { code: 'HHQ', city: 'Хуахин',  country: 'Таиланд' },
  { code: 'DAD', city: 'Дананг',  country: 'Вьетнам' },
  { code: 'CXR', city: 'Нячанг',  country: 'Вьетнам' },
  { code: 'PQC', city: 'Фукуок',  country: 'Вьетнам' },
];

// Следующие 5 месяцев для поиска
function getMonths() {
  const result = [];
  const now = new Date();
  for (let i = 0; i < 5; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    result.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return result;
}

// ── State ──────────────────────────────────────────────────────────────────
const STATE = {
  startedAt:  new Date().toISOString(),
  lastCheck:  null,
  checks:     0,
  dealsFound: 0,
  errors:     0,
  running:    false,
  sentKeys:   new Set(),
  lastRawCount: 0, // для диагностики
};

function log(msg, lvl = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${lvl.padEnd(5)}] ${msg}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Date helpers ───────────────────────────────────────────────────────────
function ruDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

function urlDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return String(d.getDate()).padStart(2,'0') + String(d.getMonth()+1).padStart(2,'0');
}

function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  return Math.round((new Date(isoB) - new Date(isoA)) / 864e5);
}

// ── Aviasales links ────────────────────────────────────────────────────────
function linkBuy(destCode, depIso, retIso) {
  const dep = urlDate(depIso);
  const ret = urlDate(retIso);
  if (!dep || !ret) return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}`;
  return `https://www.aviasales.ru/search/MOW${dep}${destCode}${ret}3?adults=3&children=2`;
}

function linkChina(destCode, depIso, retIso) {
  const dep = urlDate(depIso);
  const ret = urlDate(retIso);
  if (!dep || !ret) return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}&stops=1`;
  return `https://www.aviasales.ru/search/MOW${dep}${destCode}${ret}3?adults=3&children=2&stops=1`;
}

function stopsLabel(n) {
  if (n == null) return '';
  if (n === 0)   return 'прямой ✈️';
  if (n === 1)   return '1 пересадка';
  return `${n} пересадки`;
}

// ── Travelpayouts v1/prices/cheap ──────────────────────────────────────────
// Проверенный endpoint — возвращает cheapest RT tickets из кэша Aviasales.
// Фильтруем длительность поездки на клиенте по departure_at / return_at.
// ──────────────────────────────────────────────────────────────────────────
async function fetchCheap(destCode, month) {
  const url = new URL('https://api.travelpayouts.com/v1/prices/cheap');
  url.searchParams.set('origin',       'MOW');
  url.searchParams.set('destination',  destCode);
  url.searchParams.set('depart_date',  month);       // YYYY-MM
  url.searchParams.set('return_date',  month);       // same month = RT
  url.searchParams.set('currency',     'rub');
  url.searchParams.set('token',        CFG.tpToken);

  const r = await fetch(url.toString(), {
    headers: { 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(12000),
  });

  if (r.status === 401) throw new Error('Неверный токен Travelpayouts (401)');
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 100)}`);
  }

  const json = await r.json();
  log(`    raw: success=${json.success} data_keys=${Object.keys(json.data || {}).join(',') || 'нет'}`);

  if (!json.success) throw new Error(`API: ${json.error || 'success=false'}`);
  if (!json.data || !json.data[destCode]) return [];

  // json.data[destCode] = { "0": {...}, "1": {...} }
  return Object.values(json.data[destCode]);
}

// ── Collect all deals across destinations × months ─────────────────────────
async function collectAll() {
  const months = getMonths();
  const all    = [];
  let   rawTotal = 0;

  log(`Месяцы поиска: ${months.join(', ')}`);
  log(`Направления: ${DESTINATIONS.map(d => d.code).join(', ')}`);

  for (const dest of DESTINATIONS) {
    for (const month of months) {
      try {
        const rows = await fetchCheap(dest.code, month);
        rawTotal += rows.length;
        log(`  ${dest.code} ${month}: ${rows.length} записей из API`);

        for (const r of rows) {
          const depIso = r.departure_at || r.depart_date;
          const retIso = r.return_at    || r.return_date;
          const days   = daysBetween(depIso, retIso);

          // Фильтр: только туда-обратно с нужной длительностью
          if (!retIso)  { log(`    пропуск: нет return_at`, 'DEBUG'); continue; }
          if (days == null || days < CFG.minDays || days > CFG.maxDays) {
            log(`    пропуск: ${days} дн. (нужно ${CFG.minDays}–${CFG.maxDays})`, 'DEBUG');
            continue;
          }

          const pricePerAdult = r.price;
          if (!pricePerAdult) continue;

          const totalRub = Math.round(pricePerAdult * PAXMULT);

          all.push({
            dest,
            pricePerAdult,
            totalRub,
            days,
            depIso,
            retIso,
            airline:   r.airline    || '—',
            transfers: r.transfers  ?? null,
            linkBuy:   linkBuy(dest.code, depIso, retIso),
            linkChina: linkChina(dest.code, depIso, retIso),
          });
        }
      } catch (e) {
        log(`  ${dest.code} ${month}: ОШИБКА — ${e.message}`, 'WARN');
      }
      await sleep(400); // rate limiting
    }
  }

  STATE.lastRawCount = rawTotal;
  log(`Итого из API: ${rawTotal} записей, после фильтра длительности: ${all.length}`);
  return all.sort((a, b) => a.totalRub - b.totalRub);
}

// ── Telegram ───────────────────────────────────────────────────────────────
async function tg(text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    CFG.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.description);
    log('Telegram: ✓ отправлено');
  } catch (e) {
    log(`Telegram error: ${e.message}`, 'ERROR');
  }
}

// ── Hourly status message ──────────────────────────────────────────────────
function buildHourly(all, checkNum) {
  const now      = new Date().toLocaleString('ru-RU');
  const inBudget = all.filter(d => d.totalRub <= CFG.maxPriceTotal);
  const icon     = inBudget.length > 0 ? '🟢 ЕСТЬ В БЮДЖЕТЕ!' : '🔴 пока дороже бюджета';

  if (all.length === 0) {
    return (
      `📊 <b>Мониторинг #${checkNum}</b> · ${now}\n` +
      `✈️ Москва → 🏖 пляжи Вьетнама / Таиланда\n\n` +
      `⚠️ <b>Данных нет (${STATE.lastRawCount} записей из API, 0 подошло по длительности ${CFG.minDays}–${CFG.maxDays} дн.)</b>\n` +
      `Возможные причины:\n` +
      `• Авиасales ещё не накопил кэш по этим маршрутам\n` +
      `• Все найденные билеты короче ${CFG.minDays} или длиннее ${CFG.maxDays} дней\n\n` +
      `Следующая проверка через ${CFG.intervalMin} мин`
    );
  }

  const best = all[0];
  const pp   = Math.round(best.totalRub / (CFG.adults + CFG.children));

  let msg = `📊 <b>Мониторинг #${checkNum}</b> · ${now}\n`;
  msg += `✈️ Москва → 🏖 пляжи · туда-обратно · ${CFG.minDays}–${CFG.maxDays} дн\n`;
  msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · бюджет ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ · ${icon}\n`;
  msg += `──────────────────────\n`;
  msg += `📉 <b>Минимум: ${best.totalRub.toLocaleString('ru-RU')} ₽</b>\n`;
  msg += `🏖 ${best.dest.city}, ${best.dest.country}\n`;
  msg += `📅 ${ruDate(best.depIso)} → ${ruDate(best.retIso)} (${best.days} дн.)\n`;
  msg += `✈️ ${best.airline}`;
  if (best.transfers != null) msg += ` · ${stopsLabel(best.transfers)}`;
  msg += `\n`;
  msg += `💵 ~${pp.toLocaleString('ru-RU')} ₽/чел\n`;
  msg += `🛒 <a href="${best.linkBuy}">Купить на Aviasales</a>\n`;
  msg += `🇨🇳 <a href="${best.linkChina}">Искать с пересадкой в Китае</a>\n`;
  msg += `──────────────────────\n`;

  // Top-5 cheapest unique destinations
  const byDest = new Map();
  for (const d of all) if (!byDest.has(d.dest.code)) byDest.set(d.dest.code, d);
  const top = [...byDest.values()].slice(0, 5);

  msg += `📋 <b>Топ направлений:</b>\n`;
  top.forEach((d, i) => {
    const dpp  = Math.round(d.totalRub / (CFG.adults + CFG.children));
    const diff = d.totalRub - CFG.maxPriceTotal;
    const ds   = diff <= 0
      ? `✅ -${Math.abs(diff).toLocaleString('ru-RU')} ₽`
      : `+${diff.toLocaleString('ru-RU')} ₽`;
    msg += `${i+1}. 🏖 <b>${d.dest.city}</b> — ${d.totalRub.toLocaleString('ru-RU')} ₽ (~${dpp.toLocaleString('ru-RU')}/чел) · ${ds}\n`;
    msg += `   <a href="${d.linkBuy}">🛒 Aviasales</a> · <a href="${d.linkChina}">🇨🇳 через Китай</a>\n`;
  });

  return msg;
}

// ── Alert message (in-budget) ──────────────────────────────────────────────
function buildAlert(good) {
  const now = new Date().toLocaleString('ru-RU');
  let msg = `🔥 <b>БИЛЕТЫ В БЮДЖЕТЕ!</b> · ${now}\n`;
  msg += `🏖 Москва → пляжи Вьетнама / Таиланда · туда-обратно\n`;
  msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · до ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ на всех\n\n`;

  good.slice(0, 5).forEach((d, i) => {
    const pp = Math.round(d.totalRub / (CFG.adults + CFG.children));
    msg += `<b>${i+1}. 🏖 ${d.dest.city}, ${d.dest.country}</b>\n`;
    msg += `📅 ${ruDate(d.depIso)} → ${ruDate(d.retIso)} (${d.days} дн.)\n`;
    msg += `✈️ ${d.airline}`;
    if (d.transfers != null) msg += ` · ${stopsLabel(d.transfers)}`;
    msg += `\n`;
    msg += `💰 <b>${d.totalRub.toLocaleString('ru-RU')} ₽</b> (~${pp.toLocaleString('ru-RU')} ₽/чел)\n`;
    msg += `🛒 <a href="${d.linkBuy}">Купить на Aviasales</a>\n`;
    msg += `🇨🇳 <a href="${d.linkChina}">Искать с пересадкой в Китае</a>\n\n`;
  });

  return msg;
}

// ── Main check ─────────────────────────────────────────────────────────────
async function runCheck() {
  if (STATE.running) { log('Пропуск — ещё выполняется', 'WARN'); return; }
  STATE.running = true;
  STATE.checks++;
  log(`=== Check #${STATE.checks} ===`);

  try {
    const all = await collectAll();
    STATE.lastCheck = new Date();

    // Всегда отправляем статус
    await tg(buildHourly(all, STATE.checks));

    // Алерт только для новых предложений в бюджете
    const good = all.filter(d => d.totalRub <= CFG.maxPriceTotal);
    if (good.length > 0) {
      const fresh = good.filter(d => {
        const key = `${d.dest.code}|${d.depIso}|${d.totalRub}`;
        if (STATE.sentKeys.has(key)) return false;
        STATE.sentKeys.add(key);
        if (STATE.sentKeys.size > 500) STATE.sentKeys = new Set([...STATE.sentKeys].slice(-300));
        return true;
      });
      if (fresh.length > 0) {
        STATE.dealsFound += fresh.length;
        log(`🎉 Новых предложений в бюджете: ${fresh.length}`);
        await tg(buildAlert(fresh));
      }
    }

  } catch (e) {
    STATE.errors++;
    log(`Ошибка: ${e.message}`, 'ERROR');
    if (STATE.errors <= 2 || STATE.errors % 5 === 0) {
      await tg(`⚠️ <b>Ошибка мониторинга</b>\n<code>${e.message.slice(0,300)}</code>`);
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
      status: 'ok', uptime_sec: Math.floor(process.uptime()),
      ...STATE, sentKeys: STATE.sentKeys.size,
      config: {
        source: 'Aviasales v1/prices/cheap', tripType: 'туда-обратно',
        months: getMonths(), maxPrice: CFG.maxPriceTotal,
        paxMult: PAXMULT, nights: `${CFG.minDays}–${CFG.maxDays}`,
        intervalMin: CFG.intervalMin,
      },
    }, null, 2));
  }).listen(CFG.port, () => log(`Health :${CFG.port}`));
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  Flight Monitor v3 · пляжи VN/TH  ');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!CFG.tpToken)  { log('TRAVELPAYOUTS_TOKEN не задан', 'ERROR'); process.exit(1); }
  if (!CFG.botToken) { log('TELEGRAM_BOT_TOKEN не задан',  'ERROR'); process.exit(1); }
  if (!CFG.chatId)   { log('TELEGRAM_CHAT_ID не задан',    'ERROR'); process.exit(1); }

  log(`API     : Travelpayouts v1/prices/cheap`);
  log(`Бюджет  : ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ × ${PAXMULT} PAX`);
  log(`Ночей   : ${CFG.minDays}–${CFG.maxDays}`);
  log(`Месяцы  : ${getMonths().join(', ')}`);
  log(`Интервал: ${CFG.intervalMin} мин`);

  startServer();

  await tg(
    `🚀 <b>Flight Monitor v3 запущен</b>\n` +
    `📡 Aviasales v1/prices/cheap\n` +
    `🏖 Москва → пляжи Вьетнама и Таиланда\n` +
    `   Пхукет · Самуи · Краби · Хуахин\n` +
    `   Дананг · Нячанг · Фукуок\n` +
    `👨‍👩‍👧‍👦 3 взрослых + 2 детей · туда-обратно\n` +
    `📅 ${CFG.minDays}–${CFG.maxDays} дней\n` +
    `💰 Бюджет: ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽\n` +
    `🇨🇳 Рейсы через Китай включены\n` +
    `⏰ ${new Date().toLocaleString('ru-RU')}`
  );

  await runCheck();
  setInterval(runCheck, CFG.intervalMin * 60 * 1000);
}

main().catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
