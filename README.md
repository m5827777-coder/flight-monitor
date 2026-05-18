# ✈️ Flight Monitor — MOW → VN/TH

Мониторинг **горячих билетов Aviasales** с алертами в Telegram.
Источник: Travelpayouts `v2/prices/latest` — кэш реальных поисков пользователей за последние 48 часов.

**Параметры:** 3 взрослых + 2 детей · до 150 000 ₽ · 12–16 дней · каждые 60 мин

---

## 🔑 Шаг 1 — Получи бесплатный Travelpayouts токен

1. Зайди на [travelpayouts.com](https://travelpayouts.com) → Регистрация (бесплатно)
2. После входа: раздел **Разработчикам → API** → скопируй токен

---

## 🐙 Шаг 2 — GitHub

1. [github.com](https://github.com) → New repository → `flight-monitor` → Create
2. Загрузи все файлы:

```bash
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/ТВО_ИМЯ/flight-monitor.git
git push -u origin main
```

---

## 🚂 Шаг 3 — Railway

1. [railway.app](https://railway.app) → Sign in with GitHub
2. **New Project** → Deploy from GitHub repo → выбери `flight-monitor`

---

## ⚙️ Шаг 4 — Переменные окружения

Railway → Variables → добавь:

| Переменная | Значение |
|---|---|
| `TRAVELPAYOUTS_TOKEN` | токен с travelpayouts.com |
| `TELEGRAM_BOT_TOKEN` | токен бота |
| `TELEGRAM_CHAT_ID` | твой chat ID |
| `MAX_PRICE` | `150000` |
| `CHECK_INTERVAL_MINUTES` | `60` |

---

## ✅ Проверка

После деплоя в Telegram придёт `🚀 Flight Monitor запущен` — всё работает.

**Стоимость:** Railway ~$5/мес. Travelpayouts API — бесплатно.
