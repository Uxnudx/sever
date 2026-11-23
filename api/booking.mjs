const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const barbers = new Set(['', 'Тимур', 'Артём']);
const services = new Set(['', 'Мужская стрижка', 'Стрижка машинкой', 'Оформление бороды', 'Стрижка и борода']);

const attempts = new Map();
const attemptWindow = 60_000;
const rateLimitCleanup = setInterval(() => {
  for (const [address, attempt] of attempts) {
    if (Date.now() >= attempt.expires) attempts.delete(address);
  }
}, attemptWindow);
rateLimitCleanup.unref();

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

export default async function booking(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, {error: 'method'});
  }
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return sendJson(response, 415, {error: 'content_type'});
  }

  let data;
  try {
    const input = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? null);
    if (Buffer.byteLength(input) > 4096) {
      return sendJson(response, 413, {error: 'body_size'});
    }
    data = JSON.parse(input);
  } catch {
    return sendJson(response, 400, {error: 'json'});
  }

  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  const phone = typeof data?.phone === 'string' && data.phone.length <= 32
    ? data.phone.replace(/[\s().-]/g, '')
    : '';
  const barber = data?.barber ?? '';
  const service = data?.service ?? '';
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)
      || !/^\+?\d{10,15}$/.test(phone) || !barbers.has(barber) || !services.has(service) || data?.consent !== true) {
    return sendJson(response, 400, {error: 'fields'});
  }
  if (!token || !chatId) return sendJson(response, 503, {error: 'telegram_unconfigured'});

  const address = request.headers['x-vercel-forwarded-for'] || request.socket.remoteAddress;
  const now = Date.now();
  let attempt = attempts.get(address);
  if (!attempt || attempt.expires <= now) {
    attempt = {count: 0, expires: now + attemptWindow};
    attempts.set(address, attempt);
  }
  if (attempt.count >= 4) {
    response.setHeader('Retry-After', Math.ceil((attempt.expires - now) / 1000));
    return sendJson(response, 429, {error: 'rate_limit'});
  }
  attempt.count += 1;

  try {
    const upstream = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        chat_id: chatId,
        text: ['Заявка · Барбершоп Север', 'Имя: ' + name, 'Телефон: ' + phone,
          'Услуга: ' + (service || 'уточнить при записи'), 'Мастер: ' + (barber || 'любой свободный')].join('\n')
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!upstream.ok || (await upstream.json()).ok !== true) {
      return sendJson(response, 502, {error: 'telegram_delivery'});
    }
    return sendJson(response, 200, {ok: true});
  } catch {
    return sendJson(response, 502, {error: 'telegram_delivery'});
  }
}


