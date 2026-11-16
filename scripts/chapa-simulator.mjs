// A stand-in for Chapa on this machine, for trying deposits without a Chapa account. Local use only.
// No real Chapa is contacted and no money moves. It answers the two calls the API makes (initialize and
// verify), shows a checkout page with "Pay" and "Payment fails" buttons, and then tells the API what
// happened the way Chapa does: a signed webhook and the callback.
//
// Start it with `npm run chapa:sim`, and start the API with these in `.env`:
//   PAYMENT_PROVIDER=chapa
//   CHAPA_SECRET_KEY=CHASECK_TEST-local-simulator
//   CHAPA_WEBHOOK_SECRET=local-simulator-webhook-secret
//   CHAPA_BASE_URL=http://localhost:4010
//   WEB_APP_URL=http://localhost:5173
// Settings (environment, else `.env`, else the default): CHAPA_SIM_PORT (4010), CHAPA_WEBHOOK_SECRET,
//   CHAPA_SIM_API_URL (http://localhost:<PORT>/<API_PREFIX>), CHAPA_SIM_NOTIFY=false to send no webhook or
//   callback, as when Chapa cannot reach the API.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const fromFile = {};
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) fromFile[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const setting = (name, fallback) => process.env[name] || fromFile[name] || fallback;

const PORT = Number(setting('CHAPA_SIM_PORT', '4010'));
const SELF = `http://localhost:${PORT}`;
const API = setting(
  'CHAPA_SIM_API_URL',
  `http://localhost:${setting('PORT', '3000')}/${setting('API_PREFIX', 'api/v1')}`,
).replace(/\/+$/, '');
const WEBHOOK_SECRET = setting('CHAPA_WEBHOOK_SECRET', '');
const NOTIFY = setting('CHAPA_SIM_NOTIFY', 'true') !== 'false';

/** tx_ref -> { request, status: null | 'success' | 'failed', reference, createdAt } */
const payments = new Map();
const log = (...parts) => console.log(new Date().toLocaleTimeString('en-GB'), ...parts);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function details(txRef, payment) {
  const { request, status, reference } = payment;
  return {
    first_name: request.first_name ?? null,
    last_name: request.last_name ?? null,
    email: request.email ?? null,
    currency: request.currency,
    amount: Number(request.amount),
    charge: 0,
    mode: 'test',
    method: 'test',
    type: 'API',
    status: status ?? 'pending',
    reference,
    tx_ref: txRef,
    customization: request.customization ?? null,
    created_at: payment.createdAt,
    updated_at: new Date().toISOString(),
  };
}

/** Tells the API, as Chapa would. Failures are only logged: the API also finds out by asking `verify`. */
async function notify(txRef, payment) {
  if (!NOTIFY) return;
  const { request, status, reference } = payment;
  const calls = [];
  if (WEBHOOK_SECRET) {
    const body = JSON.stringify({
      event: status === 'success' ? 'charge.success' : 'charge.failed/cancelled',
      first_name: request.first_name ?? null,
      last_name: request.last_name ?? null,
      email: request.email ?? null,
      mobile: request.phone_number ?? null,
      currency: request.currency,
      amount: String(request.amount),
      charge: '0.00',
      status,
      mode: 'test',
      reference,
      type: 'API',
      tx_ref: txRef,
      payment_method: 'test',
    });
    calls.push([
      'webhook',
      `${API}/payments/chapa/webhook`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-chapa-signature': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'),
        },
        body,
      },
    ]);
  }
  if (typeof request.callback_url === 'string' && request.callback_url) {
    const url = new URL(request.callback_url);
    url.searchParams.set('trx_ref', txRef);
    url.searchParams.set('ref_id', reference ?? '');
    url.searchParams.set('status', status);
    calls.push(['callback', url.toString(), { method: 'GET' }]);
  }
  for (const [name, url, init] of calls) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      log(`  ${name} -> ${response.status}`);
    } catch (error) {
      log(`  ${name} could not be delivered (${error.cause?.code ?? error.name}); the API will ask verify instead`);
    }
  }
}

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f4f5;margin:0;padding:24px;color:#18181b}
  main{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px #0002}
  .note{background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:10px 12px;font-size:14px}
  h1{font-size:20px;margin:16px 0 4px} .amount{font-size:32px;font-weight:700;margin:8px 0}
  dl{font-size:14px;color:#52525b} dt{float:left;clear:left;width:90px} dd{margin:0 0 4px 90px;word-break:break-all}
  button,a.button{display:block;width:100%;box-sizing:border-box;margin-top:10px;padding:12px;border-radius:8px;
    border:1px solid #d4d4d8;background:#fff;font-size:16px;cursor:pointer;text-align:center;text-decoration:none;color:inherit}
  button.pay{background:#15803d;border-color:#15803d;color:#fff;font-weight:600}
  table{border-collapse:collapse;width:100%;font-size:14px} td,th{text-align:left;padding:6px;border-bottom:1px solid #e4e4e7}
</style></head><body><main>
<p class="note"><strong>Simulated Chapa.</strong> This page runs on your own computer. No real payment is made.</p>
${body}
</main></body></html>`;

function checkoutPage(txRef, payment) {
  const { request, status } = payment;
  const back = escapeHtml(request.return_url);
  const summary = `<h1>${escapeHtml(request.customization?.title ?? 'Payment')}</h1>
<p class="amount">${escapeHtml(request.currency)} ${escapeHtml(request.amount)}</p>
<dl><dt>Reference</dt><dd>${escapeHtml(txRef)}</dd><dt>Phone</dt><dd>${escapeHtml(request.phone_number ?? '-')}</dd></dl>`;
  if (status) {
    return page(
      'Simulated Chapa checkout',
      `${summary}<p>This payment was already ${status === 'success' ? 'paid' : 'reported as failed'}.</p>
<a class="button" href="${back}">Back to the site</a>`,
    );
  }
  const action = (name) => `/checkout/${encodeURIComponent(txRef)}/${name}`;
  return page(
    'Simulated Chapa checkout',
    `${summary}
<form method="post" action="${action('pay')}"><button class="pay" type="submit">Pay</button></form>
<form method="post" action="${action('fail')}"><button type="submit">Payment fails</button></form>
<a class="button" href="${back}">Go back without paying</a>`,
  );
}

function listPage() {
  const rows = [...payments.entries()]
    .reverse()
    .map(
      ([txRef, p]) =>
        `<tr><td><a href="/checkout/${encodeURIComponent(txRef)}">${escapeHtml(txRef)}</a></td>` +
        `<td>${escapeHtml(p.request.currency)} ${escapeHtml(p.request.amount)}</td><td>${p.status ?? 'not paid yet'}</td></tr>`,
    )
    .join('');
  return page(
    'Simulated Chapa',
    `<h1>Payments opened since this simulator started</h1>
<table><tr><th>Reference</th><th>Amount</th><th>State</th></tr>${rows || '<tr><td colspan="3">None yet.</td></tr>'}</table>`,
  );
}

async function handle(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const { pathname } = new URL(req.url ?? '/', SELF);
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const html = (status, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  const refused = (status, message) => json(status, { message, status: 'failed', data: null });

  if (pathname.startsWith('/v1/')) {
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!/^CHASECK_TEST/i.test(key)) {
      return refused(401, 'The simulator only accepts a secret key that starts with CHASECK_TEST');
    }
  }

  if (req.method === 'POST' && pathname === '/v1/transaction/initialize') {
    let request;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return refused(400, 'The request body is not JSON');
    }
    const txRef = typeof request?.tx_ref === 'string' ? request.tx_ref : '';
    if (!/^[A-Za-z0-9._-]{1,50}$/.test(txRef)) return refused(400, { tx_ref: ['The tx_ref is missing or not valid'] });
    if (!/^\d+(\.\d{1,2})?$/.test(String(request.amount)) || Number(request.amount) <= 0) {
      return refused(400, { amount: ['The amount must be a positive number'] });
    }
    if (typeof request.currency !== 'string' || !request.currency) {
      return refused(400, { currency: ['The currency field is required'] });
    }
    if (typeof request.return_url !== 'string' || !/^https?:\/\//.test(request.return_url)) {
      return refused(400, { return_url: ['The return_url must be a web address'] });
    }
    if (payments.has(txRef)) return refused(400, 'Transaction reference has been used before');
    payments.set(txRef, { request, status: null, reference: null, createdAt: new Date().toISOString() });
    log(`opened  ${txRef}  ${request.currency} ${request.amount}`);
    return json(200, {
      message: 'Hosted Link',
      status: 'success',
      data: { checkout_url: `${SELF}/checkout/${encodeURIComponent(txRef)}` },
    });
  }

  const verify = /^\/v1\/transaction\/verify\/([^/]+)$/.exec(pathname);
  if (req.method === 'GET' && verify) {
    const txRef = decodeURIComponent(verify[1]);
    const payment = payments.get(txRef);
    if (!payment) return refused(404, 'Invalid transaction or Transaction not found');
    return json(200, { message: 'Payment details', status: 'success', data: details(txRef, payment) });
  }

  const checkout = /^\/checkout\/([^/]+)(?:\/(pay|fail))?$/.exec(pathname);
  if (checkout) {
    const txRef = decodeURIComponent(checkout[1]);
    const payment = payments.get(txRef);
    if (!payment) {
      return html(
        404,
        page(
          'Simulated Chapa',
          '<h1>Payment not found</h1><p>The simulator forgets payments when it is restarted. Start a new one from the site.</p>',
        ),
      );
    }
    if (req.method === 'GET' && !checkout[2]) return html(200, checkoutPage(txRef, payment));
    if (req.method === 'POST' && checkout[2]) {
      if (!payment.status) {
        payment.status = checkout[2] === 'pay' ? 'success' : 'failed';
        payment.reference = payment.status === 'success' ? `SIM${Date.now().toString(36).toUpperCase()}` : null;
        log(`${payment.status === 'success' ? 'paid   ' : 'failed '} ${txRef}`);
        await notify(txRef, payment);
      }
      res.writeHead(303, { location: payment.request.return_url });
      return res.end();
    }
  }

  if (req.method === 'GET' && pathname === '/') return html(200, listPage());
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  return refused(404, 'Not found');
}

const listener = (req, res) =>
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });

// "localhost" is 127.0.0.1 on some machines and ::1 on others; both are answered, and nothing else.
const servers = [];
for (const host of ['127.0.0.1', '::1']) {
  const server = createServer(listener);
  await new Promise((resolve) => {
    server.once('error', (error) => {
      if (host === '127.0.0.1') {
        console.error(`The simulator could not start on port ${PORT}: ${error.message}`);
        process.exit(1);
      }
      resolve();
    });
    server.listen(PORT, host, () => {
      servers.push(server);
      resolve();
    });
  });
}

console.log(`Simulated Chapa is running at ${SELF} (no real payments).`);
console.log(`It reports payments to ${NOTIFY ? API : 'nobody (CHAPA_SIM_NOTIFY=false)'}.`);
if (NOTIFY && !WEBHOOK_SECRET) console.log('CHAPA_WEBHOOK_SECRET is not set, so no webhook is sent.');
console.log('Press Ctrl+C to stop.');

process.on('SIGINT', () => {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
  process.exit(0);
});
