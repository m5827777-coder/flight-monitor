'use strict';

const http = require('http');

// ── Config ─────────────────────────────────────────────────────────────────
const CFG = {
  tpToken:       process.env.TRAVELPAYOUTS_TOKEN,
  botToken:      process.env.TELEGRAM_BOT_TOKEN,
  chatId:        process.env.TELEGRAM_CHAT_ID,
  maxPriceTotal: parseInt(process.env.MAX_PRICE              || '150000'),
  intervalMin:   parseInt(process.env.CHECK_INTERVAL_MINUTES || '30'),
  port:          parseInt(process.env.PORT                   || '3000'),
  adults:        3,
  children:      2,
  minDays:       12,
  maxDays:       21,
};

// 3 взрослых + 2 детей × 75%
const PAXMULT = CFG.adults + CFG.children * 0.9; // 4.8

// Пляжные направления
const DESTINATIONS = [
  // 🇹🇭 Таиланд
  { code: 'HKT', city: 'Пхукет',            country: 'Таиланд' },
  { code: 'USM', city: 'Самуи',              country: 'Таиланд' },
  { code: 'KBV', city: 'Краби',              country: 'Таиланд' },
  { code: 'BKK', city: 'Бангкок',            country: 'Таиланд' },
  { code: 'HHQ', city: 'Хуахин',             country: 'Таиланд' },
  // 🇻🇳 Вьетнам
  { code: 'DAD', city: 'Дананг',             country: 'Вьетнам' },
  { code: 'CXR', city: 'Нячанг',             country: 'Вьетнам' },
  { code: 'PQC', city: 'Фукуок',             country: 'Вьетнам' },
  { code: 'SGN', city: 'Хошимин',            country: 'Вьетнам' },
  // 🇮🇩 Индонезия
  { code: 'DPS', city: 'Бали',               country: 'Индонезия' },
  { code: 'LOP', city: 'Ломбок',             country: 'Индонезия' },
  // 🇲🇾 Малайзия
  { code: 'LGK', city: 'Лангкави',           country: 'Малайзия' },
  { code: 'BKI', city: 'Кота-Кинабалу',      country: 'Малайзия' },
  { code: 'KUL', city: 'Куала-Лумпур',       country: 'Малайзия' },
  // 🇵🇭 Филиппины
  { code: 'CEB', city: 'Себу',               country: 'Филиппины' },
  { code: 'MPH', city: 'Боракай (Калибо)',   country: 'Филиппины' },
  { code: 'PPS', city: 'Палаван',            country: 'Филиппины' },
  // 🇲🇻 Мальдивы
  { code: 'MLE', city: 'Мале',               country: 'Мальдивы' },
  // 🇸🇬 Сингапур
  { code: 'SIN', city: 'Сингапур',           country: 'Сингапур' },
  // 🇰🇭 Камбоджа
  { code: 'REP', city: 'Сиемреап',           country: 'Камбоджа' },
  // 🇱🇰 Шри-Ланка
  { code: 'CMB', city: 'Коломбо',            country: 'Шри-Ланка' },
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
  nextCheck:    null,
  checks:       0,
  dealsFound:   0,
  errors:       0,
  running:      false,
  sentKeys:     new Set(),
  lastRaw:      0,
  lastPassed:   0,
  lastDeals:    [],   // сохраняем последние результаты для дашборда
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
// Travelpayouts API кэширует цены 1–3 дня — конкретный рейс может исчезнуть.
// Поэтому даём ДВЕ ссылки:
//   linkBuy   — поиск на конкретные даты с правильным числом пас. (query params)
//   linkFlex  — календарь цен на месяц: всегда актуален, сразу 5 пас.
//   linkChina — то же, но через пересадку в Китае (ищет более дешёвые варианты)

// ISO → YYYY-MM-DD (Aviasales принимает этот формат в query)
function isoDate(str) {
  if (!str) return '';
  const d = new Date(str);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Поиск на конкретные даты — может не найти если рейс раскуплен
function linkBuy(destCode, depStr, retStr) {
  const dep = isoDate(depStr), ret = isoDate(retStr);
  const base = `https://www.aviasales.ru/search/MOW0${destCode}0`;
  if (!dep || !ret) {
    return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}&adults=3&children=2`;
  }
  // Aviasales query-param формат: гарантированно открывает с нужным числом пас.
  return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}&depart_date=${dep}&return_date=${ret}&adults=3&children=2`;
}

// Календарь цен на весь месяц — всегда актуален
function linkFlex(destCode, depStr) {
  const d = depStr ? new Date(depStr) : new Date();
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `https://www.aviasales.ru/calendar/MOW${destCode}?adults=3&children=2&one_way=false&month=${month}`;
}

// Поиск через Китай (пересадка) — ищет дешевле
function linkChina(destCode, depStr, retStr) {
  const dep = isoDate(depStr), ret = isoDate(retStr);
  if (!dep || !ret) {
    return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}&adults=3&children=2&stops=1`;
  }
  return `https://www.aviasales.ru/?origin=MOW&destination=${destCode}&depart_date=${dep}&return_date=${ret}&adults=3&children=2&stops=1`;
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

          // Основной диапазон + ±2 дня (помечаем как ⚡ вне диапазона)
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
            linkFlex:  linkFlex(dest.code),
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
  const sorted = all.sort((a, b) => a.totalRub - b.totalRub);
  STATE.lastDeals = sorted;  // сохраняем для дашборда
  log(`Итого: ${raw} из API → ${passed} прошло фильтр`);
  return sorted;
}

// ── Telegram ───────────────────────────────────────────────────────────────
// buttons: [[{ text, url }], ...] — массив рядов кнопок (inline keyboard)
async function tg(text, buttons) {
  const body = {
    chat_id:                  CFG.chatId,
    text,
    parse_mode:               'HTML',
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length) {
    body.reply_markup = { inline_keyboard: buttons };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
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
  msg += `✈️ Москва → 🏖 пляжи ЮВА · туда-обратно · ${CFG.minDays}–${CFG.maxDays} дн\n`;
  msg += `👨‍👩‍👧‍👦 3 взр + 2 дет · бюджет ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽ · ${icon}\n`;
  msg += `──────────────────────\n`;
  msg += `📉 <b>Минимум: ${best.totalRub.toLocaleString('ru-RU')} ₽</b>${near}\n`;
  msg += `🏖 ${best.dest.city}, ${best.dest.country}\n`;
  msg += `📅 ${ruDate(best.depStr)} → ${ruDate(best.retStr)} (${best.days} дн.)\n`;
  msg += `✈️ ${best.airline}`;
  if (best.transfers != null) msg += ` · ${stopsLabel(best.transfers)}`;
  msg += `\n💵 ~${pp.toLocaleString('ru-RU')} ₽/чел\n`;
  msg += `🛒 <a href="${best.linkBuy}">Купить на Aviasales</a> · <a href="${best.linkFlex}">📅 гибкие даты</a>\n`;
  msg += `🇨🇳 <a href="${best.linkChina}">Искать через Китай</a>\n`;
  msg += `⚠️ <i>Цена расчётная (×4.8). Итог на сайте — для 5 пас.</i>\n`;
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

  // Inline-кнопки: по одной строке на каждый рейс
  const buttons = [];

  good.slice(0, 5).forEach((d, i) => {
    const pp = Math.round(d.totalRub / (CFG.adults + CFG.children));
    msg += `<b>${i+1}. 🏖 ${d.dest.city}, ${d.dest.country}</b>\n`;
    msg += `📅 ${ruDate(d.depStr)} → ${ruDate(d.retStr)} (${d.days} дн.)\n`;
    msg += `✈️ ${d.airline}`;
    if (d.transfers != null) msg += ` · ${stopsLabel(d.transfers)}`;
    msg += `\n💰 <b>${d.totalRub.toLocaleString('ru-RU')} ₽</b> (~${pp.toLocaleString('ru-RU')} ₽/чел)\n\n`;

    // Кнопки: [🛒 Купить] [📅 Даты] [🇨🇳 Китай]
    buttons.push([
      { text: `🛒 ${d.dest.city} — ${d.totalRub.toLocaleString('ru-RU')} ₽`, url: d.linkBuy },
    ]);
    buttons.push([
      { text: `📅 Гибкие даты`, url: d.linkFlex },
      { text: `🇨🇳 Через Китай`, url: d.linkChina },
    ]);
  });

  return { msg, buttons };
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
        const { msg, buttons } = buildAlert(fresh);
        await tg(msg, buttons);
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

// ── Web Dashboard ──────────────────────────────────────────────────────────
function renderDashboard() {
  const deals = STATE.lastDeals || [];
  const now   = new Date().toLocaleString('ru-RU');
  const upMin = Math.floor(process.uptime() / 60);
  const next  = STATE.nextCheck ? new Date(STATE.nextCheck).toLocaleString('ru-RU') : '—';
  const budget= CFG.maxPriceTotal;

  const inBudget = deals.filter(d => d.totalRub <= budget && d.inRange);
  const statusColor = inBudget.length > 0 ? '#22d3a0' : '#f59e0b';
  const statusText  = inBudget.length > 0
    ? `🟢 НАЙДЕНО ${inBudget.length} В БЮДЖЕТЕ!`
    : `🟡 Пока дороже бюджета`;

  // Unique by destination (cheapest per dest)
  const byDest = new Map();
  for (const d of deals) if (!byDest.has(d.dest.code)) byDest.set(d.dest.code, d);
  const top = [...byDest.values()].slice(0, 20);

  const rows = top.map(d => {
    const pp   = Math.round(d.totalRub / (CFG.adults + CFG.children));
    const diff = d.totalRub - budget;
    const ok   = diff <= 0;
    const flag = { 'Таиланд':'🇹🇭','Вьетнам':'🇻🇳','Индонезия':'🇮🇩','Малайзия':'🇲🇾',
                   'Филиппины':'🇵🇭','Мальдивы':'🇲🇻','Сингапур':'🇸🇬','Камбоджа':'🇰🇭','Шри-Ланка':'🇱🇰' }[d.dest.country] || '🏖';
    const near = d.inRange ? '' : ' <span style="color:#f59e0b;font-size:11px">⚡±2дн</span>';
    const diffStr = ok
      ? `<span style="color:#22d3a0">✅ -${Math.abs(diff).toLocaleString('ru-RU')} ₽</span>`
      : `<span style="color:#f87171">+${diff.toLocaleString('ru-RU')} ₽</span>`;
    return `<tr style="border-bottom:1px solid #1a2e4a">
      <td style="padding:10px 8px;font-weight:600;white-space:nowrap">${flag} ${d.dest.city}${near}</td>
      <td style="padding:10px 8px;color:#94a3b8">${d.dest.country}</td>
      <td style="padding:10px 8px;white-space:nowrap">${ruDate(d.depStr)} → ${ruDate(d.retStr)}</td>
      <td style="padding:10px 8px;color:#94a3b8;text-align:center">${d.days}д</td>
      <td style="padding:10px 8px;color:#94a3b8">${d.airline}</td>
      <td style="padding:10px 8px;font-weight:700;font-size:16px;color:${ok?'#22d3a0':'#e2eaf5'};white-space:nowrap">${d.totalRub.toLocaleString('ru-RU')} ₽</td>
      <td style="padding:10px 8px;color:#64748b;white-space:nowrap">~${pp.toLocaleString('ru-RU')}/чел</td>
      <td style="padding:10px 8px">${diffStr}</td>
      <td style="padding:10px 8px;white-space:nowrap">
        <a href="${d.linkBuy}" target="_blank" style="background:#1d4ed8;color:#fff;padding:5px 10px;border-radius:6px;text-decoration:none;font-size:12px;margin-right:4px">🛒 Купить</a>
        <a href="${d.linkFlex}" target="_blank" style="background:#0f4c81;color:#fff;padding:5px 10px;border-radius:6px;text-decoration:none;font-size:12px">📅 Даты</a>
      </td>
    </tr>`;
  }).join('');

  const noData = deals.length === 0
    ? `<tr><td colspan="9" style="text-align:center;padding:40px;color:#334155">
        ${STATE.running ? '⟳ Идёт проверка...' : 'Нет данных. Ожидаем следующую проверку.'}
       </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>✈️ Flight Monitor · MOW → ЮВА</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#060b16;color:#c8d6e8;min-height:100vh}
  .header{background:linear-gradient(135deg,#0d1f3c,#0a1628);border-bottom:1px solid #1a2e4a;padding:16px 24px}
  .title{font-size:22px;font-weight:700;color:#e2eaf5}
  .sub{font-size:13px;color:#64748b;margin-top:4px}
  .status{display:inline-block;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:600;background:#0d1f3c;border:1px solid ${statusColor};color:${statusColor}}
  .stats{display:flex;gap:12px;flex-wrap:wrap;padding:14px 24px;background:#0a1220;border-bottom:1px solid #1a2e4a}
  .stat{background:#0d1f3c;border:1px solid #1a3a5c;border-radius:8px;padding:8px 16px;font-size:13px}
  .stat b{display:block;font-size:18px;color:#7db4e0}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{background:#0d1f3c;padding:10px 8px;text-align:left;font-size:11px;letter-spacing:1px;color:#475569;text-transform:uppercase;position:sticky;top:0}
  tr:hover td{background:#0d1f2a}
  .wrap{overflow-x:auto;padding:16px 24px}
  .note{font-size:11px;color:#334155;padding:12px 24px;border-top:1px solid #1a2e4a;text-align:center}
  @media(max-width:600px){.stats{padding:10px 12px}.wrap{padding:10px 12px}th,td{font-size:12px;padding:8px 5px}}
</style>
</head>
<body>
<div class="header">
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
    <div>
      <div class="title">✈️ MOW → ЮВА · Flight Monitor</div>
      <div class="sub">3 взр + 2 дет · туда-обратно · ${CFG.minDays}–${CFG.maxDays} дней · бюджет ${budget.toLocaleString('ru-RU')} ₽</div>
    </div>
    <div class="status">${statusText}</div>
  </div>
</div>
<div class="stats">
  <div class="stat"><b>${now}</b>последняя проверка</div>
  <div class="stat"><b>${next}</b>следующая</div>
  <div class="stat"><b>${STATE.checks}</b>проверок</div>
  <div class="stat"><b>${STATE.dealsFound}</b>алертов отправлено</div>
  <div class="stat"><b>${upMin} мин</b>аптайм</div>
  <div class="stat"><b>${deals.length}</b>маршрутов найдено</div>
</div>
<div class="wrap">
<table>
  <thead><tr>
    <th>Направление</th><th>Страна</th><th>Даты</th><th>Дней</th>
    <th>Авиа</th><th>Итого 5 пас.</th><th>На чел.</th><th>vs бюджет</th><th>Купить</th>
  </tr></thead>
  <tbody>${rows}${noData}</tbody>
</table>
</div>
<div class="note">
  ⚠️ Цены расчётные (API × ${PAXMULT}). Финальная цена — на сайте Aviasales для 5 пассажиров. 
  Страница обновляется каждые 60 сек автоматически.
  Проверок API: каждые ${CFG.intervalMin} мин.
</div>
</body>
</html>`;
}

function startServer() {
  http.createServer((req, res) => {
    if (req.url === '/json') {
      // JSON endpoint для отладки
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', uptime_sec: Math.floor(process.uptime()),
        checks: STATE.checks, deals: STATE.lastDeals.length,
        dealsFound: STATE.dealsFound, errors: STATE.errors,
      }, null, 2));
    } else {
      // HTML Dashboard
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboard());
    }
  }).listen(CFG.port, () => log(`Dashboard: http://localhost:${CFG.port}`));
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
    `🏖 Москва → пляжи Юго-Восточной Азии\n` +
    `   🇹🇭 Пхукет · Самуи · Краби · Хуахин\n` +
    `   🇻🇳 Дананг · Нячанг · Фукуок\n` +
    `   🇮🇩 Бали · Ломбок · 🇲🇾 Лангкави · Кота-Кинабалу\n` +
    `   🇵🇭 Себу · Боракай · Палаван · 🇲🇻 Мальдивы\n` +
    `   🇸🇬 Сингапур · 🇰🇭 Сиемреап · 🇱🇰 Коломбо\n` +
    `👨‍👩‍👧‍👦 3 взрослых + 2 детей · туда-обратно\n` +
    `📅 ${CFG.minDays}–${CFG.maxDays} дней\n` +
    `💰 Бюджет: ${CFG.maxPriceTotal.toLocaleString('ru-RU')} ₽\n` +
    `🇨🇳 Рейсы через Китай включены\n` +
    `⏰ ${new Date().toLocaleString('ru-RU')}`
  );

  STATE.nextCheck = new Date(Date.now() + CFG.intervalMin * 60000).toISOString();
  await runCheck();
  setInterval(() => {
    STATE.nextCheck = new Date(Date.now() + CFG.intervalMin * 60000).toISOString();
    runCheck();
  }, CFG.intervalMin * 60 * 1000);
}

main().catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
