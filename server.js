'use strict';

// ════════════════════════════════════════════════════
// Кафе #ДОМ — Backend Server
// Запуск: node server.js
// Требует переменных окружения (см. .env.example)
// ════════════════════════════════════════════════════

const express = require('express');
const https   = require('https');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ── Конфиг из переменных окружения ──
const SHOP_ID    = process.env.YOOKASSA_SHOP_ID    || '';
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN  || '8643611676:AAGgbJh1HIaOPJkfL9bvLGcevp4XuePT4D8';
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID    || '829247940';
const BASE_URL   = process.env.BASE_URL            || 'http://localhost:3000';
const PORT       = process.env.PORT                || 3000;

// ── Отдаём фронтенд ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'DOM.html'));
});

// ════════════════════════════════════════════════════
// POST /api/create-payment
// Создаёт платёж в YooKassa и возвращает ссылку для оплаты
// ════════════════════════════════════════════════════
app.post('/api/create-payment', async (req, res) => {
  const { amount, orderNum, name, phone, addr, dType, tType, time, comment, items } = req.body;

  if (!SHOP_ID || !SECRET_KEY) {
    return res.json({ ok: false, error: 'YooKassa не настроена. Заполните YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.' });
  }

  const amountRub = parseFloat(amount).toFixed(2);
  const returnUrl = `${BASE_URL}/?order=${orderNum}&status=paid`;

  const payload = {
    amount: { value: amountRub, currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: returnUrl },
    description: `Заказ #${orderNum} — кафе #ДОМ`,
    metadata: {
      orderNum:  String(orderNum),
      name:      name  || '',
      phone:     phone || '',
      addr:      addr  || '',
      dType:     dType || 'delivery',
      tType:     tType || 'asap',
      time:      time  || '',
      comment:   comment || '',
      itemsJson: JSON.stringify(items || [])
    }
  };

  try {
    const result = await yookassaRequest('POST', '/v3/payments', payload, uuidv4());
    if (result.confirmation && result.confirmation.confirmation_url) {
      res.json({ ok: true, paymentId: result.id, confirmationUrl: result.confirmation.confirmation_url });
    } else {
      console.error('YooKassa response:', JSON.stringify(result));
      res.json({ ok: false, error: result.description || 'Не удалось создать платёж' });
    }
  } catch (err) {
    console.error('YooKassa error:', err.message);
    res.json({ ok: false, error: 'Ошибка соединения с YooKassa' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/webhook
// Принимает уведомление от YooKassa об успешной оплате
// ════════════════════════════════════════════════════
app.post('/api/webhook', (req, res) => {
  // Отвечаем 200 сразу, чтобы YooKassa не ретраила
  res.sendStatus(200);

  const body = req.body;
  if (!body || body.event !== 'payment.succeeded') return;

  const meta = (body.object && body.object.metadata) || {};
  const amountVal = body.object && body.object.amount ? body.object.amount.value : '?';

  let items = [];
  try { items = JSON.parse(meta.itemsJson || '[]'); } catch (_) {}

  sendTelegram(meta, items, amountVal);
});

// ════════════════════════════════════════════════════
// Отправка сообщения в Telegram
// ════════════════════════════════════════════════════
function sendTelegram(meta, items, amountVal) {
  const lines = items.map(i => `• ${i.name} × ${i.qty} = ${i.price * i.qty} ₽`).join('\n');

  const typeLabel = meta.dType === 'pickup' ? '🏠 Самовывоз' : '🚴 Доставка';
  const timeLabel = meta.tType === 'asap'
    ? 'Ближайшее (~30–40 мин)'
    : `К ${meta.time || '—'}`;
  const addrLine  = meta.dType !== 'pickup' && meta.addr
    ? `\n📍 Адрес: ${meta.addr}`
    : '';

  const msg = `🆕 Заказ #${meta.orderNum}\n\n`
    + `${lines}\n\n`
    + `💰 Итого: ${amountVal} ₽ (оплачено онлайн)\n`
    + `${typeLabel}${addrLine}\n`
    + `⏰ Время: ${timeLabel}\n`
    + `👤 ${meta.name}\n`
    + `📞 ${meta.phone}`
    + (meta.comment ? `\n💬 ${meta.comment}` : '');

  tgPost('sendMessage', { chat_id: TG_CHAT, text: msg });
}

// ════════════════════════════════════════════════════
// Вспомогательные функции HTTP
// ════════════════════════════════════════════════════

function yookassaRequest(method, path_, body, idempotencyKey) {
  const auth = Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64');
  return jsonRequest({
    hostname: 'api.yookassa.ru',
    path:     path_,
    method,
    headers: {
      'Content-Type':    'application/json',
      'Authorization':   `Basic ${auth}`,
      'Idempotency-Key': idempotencyKey
    }
  }, body);
}

function tgPost(method, body) {
  return jsonRequest({
    hostname: 'api.telegram.org',
    path:     `/bot${TG_TOKEN}/${method}`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json' }
  }, body).catch(err => console.error('Telegram error:', err.message));
}

function jsonRequest(options, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = { ...options, headers: { ...options.headers, 'Content-Length': Buffer.byteLength(data) } };
    const req  = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (_) { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ════════════════════════════════════════════════════
// Старт
// ════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`#ДОМ сервер запущен: http://localhost:${PORT}`);
  if (!SHOP_ID) console.warn('⚠️  YOOKASSA_SHOP_ID не задан — онлайн-оплата недоступна');
});
