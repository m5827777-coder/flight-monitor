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
  maxDays:       21,
};

// 3 взрослых + 2 детей × 75%
const PAXMULT = CFG.adults + CFG.children * 0.75; // 4.5

// Пляжные направления
const DESTINATIONS = [
  { code: 'HKT', city: 'Пхукет',  country: 'Таиланд' },
  { code: 'USM', city: 'Самуи',   country: 'Таиланд' },
  { code: 'KBV', city: 'Краби',   country: 'Таиланд' },
  { code: 'BKK', city: 'Бангкок', country: 'Таиланд' },
  { code: 'DAD', city: 'Дананг',  country: 'Вьетнам' },
  { code: 'CXR', city: 'Нячанг',  country: 'Вьетнам' },
  { code: 'PQC', city: 'Фукуок',  country: 'Вьетнам' },
  { code: 'SGN', city: 'Хошимин', country: 'Вьетнам' },
];

// Следующие 5 месяцев
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
  startedAt:    new Date().toISOString(),
  lastCheck:    null,
  checks:       0,
  dealsFound:   0,
  errors:       0,
  running:      false,
  sentKeys:     new Set(),
  lastRaw:      0,
  lastPassed:   0,
};

function log(msg, lvl = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${lvl.padEnd(5)}] ${msg}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Date helpers ───────────────────────────────────────────────────────────
function ruDate(str) {
  if (!str) return '—';
  // str может быть "2026-07-15" или ISO
  const d = new Date(str);
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

function urlDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return String(d.getDate()).padStart(2,'0') + String(d.getMonth()+1).padStart(2,'0');
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 864e5);
}

// ── Aviasales links ────────────────────────────────────────────────────────
function linkBuy(destCode, depStr, retStr) {
  const dep = urlDate(depStr), ret = urlDate(retStr);
  if (!dep || !ret) return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}`;
  // Format: {adults}{child1_age}{child2_age} → "31010" = 3 adults + 2 children age 10
  return `https://www.aviasales.ru/search/MOW${dep}${destCode}${ret}31010`;
}

function linkChina(destCode, depStr, retStr) {
  const dep = urlDate(depStr), ret = urlDate(retStr);
  if (!dep || !ret) return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}`;
  return `https://www.aviasales.ru/search/MOW${dep}${destCode}${ret}31010?stops=1`;
}

function stopsLabel(n) {
  if (n == null) return '';
  if (n === 0)   return 'прямой ✈️';
  if (n === 1)   return '1 пересадка';
  return `${n} пересадки`;
}

// ── Travelpayouts aviasales/v3/prices_for_dates ────────────────────────────
// Новый endpoint — возвращает реальные RT билеты по датам.
// one_way=false → только туда-обратно.
// ──────────────────────────────────────────────────────────────────────────
async function fetchV3(destCode, month) {
  const url = new URL('https://api.travelpayouts.com/aviasales/v3/prices_for_dates');
  url.searchParams.set('origin',       'MOW');
  url.searchParams.set('destination',  destCode);
  url.searchParams.set('departure_at', month);      // YYYY-MM
  url.searchParams.set('one_way',      'false');     // только RT
  url.searchParams.set('direct',       'false');     // с пересадками тоже
  url.searchParams.set('sorting',      'price');
  url.searchParams.set('limit',        '30');
  url.searchParams.set('currency',     'rub');
  url.searchParams.set('market',       'ru');
  url.searchParams.set('token',        CFG.tpToken);

  const r = await fetch(url.toString(), {
    headers: { 'Accept-Encoding': 'gzip, deflate' },
    signal:  AbortSignal.timeout(15000),
  });

  if (r.status === 401) throw new Error('Неверный токен (401)');
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 150)}`);
  }

  const json = await r.json();
  log(`    v3 ${destCode} ${month}: success=${json.success} data.length=${(json.data||[]).length}`);

  if (!json.success) throw new Error(`API: ${json.error || 'success=false'}`);
  return json.data || [];
}

// ── Collect ────────────────────────────────────────────────────────────────
async function collectAll() {
  const months = getMonths();
  const all = [];
  let raw = 0, passed = 0;

  log(`Endpoint: aviasales/v3/prices_for_dates`);
  log(`Направления: ${DESTINATIONS.map(d => d.code).join(' ')}`);
  log(`Месяцы: ${months.join(' ')}`);

  for (const dest of DESTINATIONS) {
    for (const month of months) {
      try {
        const rows = await fetchV3(dest.code, month);
        raw += rows.length;

        for (const r of rows) {
          // v3 поля: price, departure_at, return_at, airline, transfers, duration
          const depStr = r.departure_at;
          const retStr = r.return_at;
          const price  = r.price;

          if (!price || !retStr) continue; // пропускаем OW

          const days = daysBetween(depStr, retStr);

          // Принимаем в диапазоне ±2 дня от заданного
          if (days == null || days < CFG.minDays - 2 || days > CFG.maxDays + 2) continue;

          const inRange = days >= CFG.minDays && days <= CFG.maxDays;
          const totalRub = Math.round(price * PAXMULT);
          passed++;

          all.push({
            dest,
            price,
            totalRub,
            days,
            inRange,
            depStr,
            retStr,
            airline:   r.airline    || '—',
            transfers: r.transfers  ?? r.number_of_changes ?? null,
            linkBuy:   linkBuy(dest.code, depStr, retStr),
            linkChina: linkChina(dest.code, depStr, retStr),
          });
        }
      } catch (e) {
        log(`  ${dest.code} ${month}: ${e.message}`, 'WARN');
      }
      await sleep(300);
    }
  }

  STATE.lastRaw    = raw;
  STATE.lastPassed = passed;
  log(`Итого: ${raw} из API → ${passed} прошло фильтр`);
  return all.sort((a, b) => a.totalRub - b.totalRub);
}

// ── Telegram ───────────────────────────────────────────────────────────────
async function tg(text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:                  CFG.chatId,
        text,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.description);
    log('Telegram ✓');
  } catch (e) {
    log(`Telegram: ${e.message}`, 'ERROR');
  }
}

// ── Hourly status ──────────────────────────────────────────────────────────
function buildHourly(all, n) {
  const now      = new Date().toLocaleString('ru-RU');
  const inBudget = all.filter(d => d.totalRub <= CFG.maxPriceTotal && d.inRange);
  const icon     = inBudget.length > 0 ? '🟢 ЕСТЬ В БЮДЖЕТЕ!' : '🔴 пока дороже бюджета';

  if (all.length === 0) {
    return (
      `📊 <b>Мониторинг #${n}</b> · ${now}\n\n` +
      `⚠️ Данных нет\n` +
      `Записей из API: ${STATE.lastRaw}\n` +
      `Прошло фильтр: ${STATE.lastPassed}\n` +
      `Диапазон: ${CFG.minDays}–${CFG.maxDays} дн (±2)\n\n` +
      `Следующая проверка через ${CFG.intervalMin} мин`
    );
  }

  const best = all[0];
  const pp   = Math.round(best.totalRub / (CFG.adults + CFG.children));
  const near = best.inRange ? '' : ' ⚡ближайший';

  let msg = `📊 <b>Мониторинг #${n}</b> · ${now}\n`;
  msg += `✈️ Москва → 🏖 пляжи · туда-обратно · ${CFG.minDays}–${CFG.maxDays} дн\n`;
  msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · бюджет ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ · ${icon}\n`;
  msg += `──────────────────────\n`;
  msg += `📉 <b>Минимум: ${best.totalRub.toLocaleString('ru-RU')} ₽</b>${near}\n`;
  msg += `🏖 ${best.dest.city}, ${best.dest.country}\n`;
  msg += `📅 ${ruDate(best.depStr)} → ${ruDate(best.retStr)} (${best.days} дн.)\n`;
  msg += `✈️ ${best.airline}`;
  if (best.transfers != null) msg += ` · ${stopsLabel(best.transfers)}`;
  msg += `\n💵 ~${pp.toLocaleString('ru-RU')} ₽/чел\n`;
  msg += `🛒 <a href="${best.linkBuy}">Купить на Aviasales</a>\n`;
  msg += `🇨🇳 <a href="${best.linkChina}">Искать через Китай</a>\n`;
  msg += `──────────────────────\n`;

  // Топ по уникальным направлениям
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
    const near2 = d.inRange ? '' : ' ⚡';
    msg += `${i+1}. 🏖 <b>${d.dest.city}</b>${near2} — ${d.totalRub.toLocaleString('ru-RU')} ₽ (~${dpp.toLocaleString('ru-RU')}/чел) · ${ds}\n`;
    msg += `   <a href="${d.linkBuy}">🛒 Aviasales</a> · <a href="${d.linkChina}">🇨🇳 через Китай</a>\n`;
  });

  return msg;
}

// ── Alert ──────────────────────────────────────────────────────────────────
function buildAlert(good) {
  const now = new Date().toLocaleString('ru-RU');
  let msg = `🔥 <b>БИЛЕТЫ В БЮДЖЕТЕ!</b> · ${now}\n`;
  msg += `🏖 Москва → пляжи · туда-обратно\n`;
  msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · до ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽\n\n`;
  good.slice(0, 5).forEach((d, i) => {
    const pp = Math.round(d.totalRub / (CFG.adults + CFG.children));
    msg += `<b>${i+1}. 🏖 ${d.dest.city}, ${d.dest.country}</b>\n`;
    msg += `📅 ${ruDate(d.depStr)} → ${ruDate(d.retStr)} (${d.days} дн.)\n`;
    msg += `✈️ ${d.airline}`;
    if (d.transfers != null) msg += ` · ${stopsLabel(d.transfers)}`;
    msg += `\n💰 <b>${d.totalRub.toLocaleString('ru-RU')} ₽</b> (~${pp.toLocaleString('ru-RU')} ₽/чел)\n`;
    msg += `🛒 <a href="${d.linkBuy}">Купить на Aviasales</a>\n`;
    msg += `🇨🇳 <a href="${d.linkChina}">Искать через Китай</a>\n\n`;
  });
  return msg;
}

// ── Main check ─────────────────────────────────────────────────────────────
async function runCheck() {
  if (STATE.running) { log('Пропуск', 'WARN'); return; }
  STATE.running = true;
  STATE.checks++;
  log(`=== Check #${STATE.checks} ===`);

  try {
    const all = await collectAll();
    STATE.lastCheck = new Date();

    await tg(buildHourly(all, STATE.checks));

    const good = all.filter(d => d.totalRub <= CFG.maxPriceTotal && d.inRange);
    if (good.length > 0) {
      const fresh = good.filter(d => {
        const key = `${d.dest.code}|${d.depStr}|${d.totalRub}`;
        if (STATE.sentKeys.has(key)) return false;
        STATE.sentKeys.add(key);
        if (STATE.sentKeys.size > 500) STATE.sentKeys = new Set([...STATE.sentKeys].slice(-300));
        return true;
      });
      if (fresh.length > 0) {
        STATE.dealsFound += fresh.length;
        log(`🎉 Новых в бюджете: ${fresh.length}`);
        await tg(buildAlert(fresh));
      }
    }

  } catch (e) {
    STATE.errors++;
    log(`Ошибка: ${e.message}`, 'ERROR');
    if (STATE.errors <= 2 || STATE.errors % 5 === 0) {
      await tg(`⚠️ <b>Ошибка</b>\n<code>${e.message.slice(0, 300)}</code>`);
    }
  } finally {
    STATE.running = false;
    log(`=== Check #${STATE.checks} done ===`);
  }
}

// ── Health ─────────────────────────────────────────────────────────────────
function startServer() {
  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', uptime_sec: Math.floor(process.uptime()),
      ...STATE, sentKeys: STATE.sentKeys.size,
      config: {
        endpoint:    'aviasales/v3/prices_for_dates',
        months:      getMonths(),
        maxPrice:    CFG.maxPriceTotal,
        paxMult:     PAXMULT,
        nights:      `${CFG.minDays}–${CFG.maxDays}`,
        intervalMin: CFG.intervalMin,
      },
    }, null, 2));
  }).listen(CFG.port, () => log(`Health :${CFG.port}`));
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  Flight Monitor v5 · v3 API        ');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!CFG.tpToken)  { log('TRAVELPAYOUTS_TOKEN не задан', 'ERROR'); process.exit(1); }
  if (!CFG.botToken) { log('TELEGRAM_BOT_TOKEN не задан',  'ERROR'); process.exit(1); }
  if (!CFG.chatId)   { log('TELEGRAM_CHAT_ID не задан',    'ERROR'); process.exit(1); }

  log(`API     : aviasales/v3/prices_for_dates`);
  log(`Бюджет  : ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ × ${PAXMULT}`);
  log(`Ночей   : ${CFG.minDays}–${CFG.maxDays}`);
  log(`Месяцы  : ${getMonths().join(', ')}`);
  log(`Интервал: ${CFG.intervalMin} мин`);

  startServer();

  await tg(
    `🚀 <b>Flight Monitor v5 запущен</b>\n` +
    `📡 Aviasales API v3 (prices_for_dates)\n` +
    `🏖 Москва → пляжи Вьетнама и Таиланда\n` +
    `   Пхукет · Самуи · Краби · Бангкок\n` +
    `   Дананг · Нячанг · Фукуок · Хошимин\n` +
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
