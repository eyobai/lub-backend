import { createHmac } from 'node:crypto';
import {
  checkoutUrlAllowed,
  decimalToMinor,
  isLocalHttpUrl,
  isTestKey,
  judgeVerification,
  minorToDecimal,
  webhookSignatureValid,
} from './chapa.rules';
import type { ChapaVerification, ExpectedPayment } from './chapa.rules';

const expected: ExpectedPayment = {
  txRef: 'LUB-0123456789ABCDEFGHJK',
  amountMinor: 12550n,
  currency: 'ETB',
  minorUnits: 2,
  testMode: true,
};
const paid: ChapaVerification = {
  status: 'success',
  amount: 125.5,
  currency: 'ETB',
  tx_ref: expected.txRef,
  mode: 'test',
  reference: 'APfxyz123',
};

describe('minorToDecimal', () => {
  it.each([
    [12550n, 2, '125.50'],
    [5n, 2, '0.05'],
    [100n, 2, '1.00'],
    [5000000n, 2, '50000.00'],
    [1234n, 0, '1234'],
    [1234n, 3, '1.234'],
  ])('formats %s with %s minor units as %s', (minor, units, text) => {
    expect(minorToDecimal(minor, units)).toBe(text);
  });
});

describe('decimalToMinor', () => {
  it.each([
    ['125.50', 12550n],
    ['125.5', 12550n],
    ['125', 12500n],
    [125.5, 12550n],
    [100, 10000n],
    ['0.05', 5n],
    ['125.500', 12550n],
    [' 10.00 ', 1000n],
  ])('reads %p as %s santim', (value, minor) => {
    expect(decimalToMinor(value, 2)).toBe(minor);
  });

  it.each([['125.505'], ['-5'], ['1e3'], ['12,50'], [''], ['abc'], [null], [undefined], [{}], [NaN], [1e21]])(
    'refuses %p',
    (value) => {
      expect(decimalToMinor(value, 2)).toBeNull();
    },
  );

  it('does not lose precision on amounts a float would round', () => {
    expect(decimalToMinor('90071992547409.93', 2)).toBe(9007199254740993n);
  });
});

describe('judgeVerification', () => {
  it('accepts a successful payment that matches in every detail', () => {
    expect(judgeVerification(paid, expected)).toEqual({ state: 'paid', reference: 'APfxyz123' });
  });

  it('accepts the amount as text and the currency in any letter case', () => {
    expect(judgeVerification({ ...paid, amount: '125.50', currency: 'etb' }, expected).state).toBe('paid');
  });

  it('keeps a payment without a provider reference', () => {
    expect(judgeVerification({ ...paid, reference: undefined }, expected)).toEqual({ state: 'paid', reference: null });
  });

  it.each([[null], [undefined], [{}], [{ status: 'pending' }], [{ status: 'something-new' }], [{ status: 7 }]])(
    'treats %p as still pending',
    (data) => {
      expect(judgeVerification(data as ChapaVerification, expected)).toEqual({ state: 'pending' });
    },
  );

  it.each(['failed', 'cancelled', 'failed/cancelled', 'FAILED', 'reversed', 'refunded'])(
    'treats status %s as failed',
    (status) => {
      expect(judgeVerification({ ...paid, status }, expected).state).toBe('failed');
    },
  );

  it.each([
    ['a smaller amount', { amount: 1.25 }],
    ['a larger amount', { amount: '1255.00' }],
    ['a missing amount', { amount: undefined }],
    ['an unreadable amount', { amount: '125.50 ETB' }],
    ['another currency', { currency: 'USD' }],
    ['a missing currency', { currency: undefined }],
    ['another reference', { tx_ref: 'LUB-SOMEONEELSE000000000' }],
    ['live mode under a test key', { mode: 'live' }],
    ['a missing mode', { mode: undefined }],
  ])('refuses a success with %s', (_name, change) => {
    expect(judgeVerification({ ...paid, ...change }, expected).state).toBe('mismatch');
  });

  it('refuses a test payment when the key in use is live', () => {
    expect(judgeVerification(paid, { ...expected, testMode: false }).state).toBe('mismatch');
    expect(judgeVerification({ ...paid, mode: 'live' }, { ...expected, testMode: false }).state).toBe('paid');
  });
});

describe('webhookSignatureValid', () => {
  const secret = 'webhook-secret-for-tests-0001';
  const body = JSON.stringify({ event: 'charge.success', tx_ref: expected.txRef });
  const sign = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');

  it('accepts x-chapa-signature: the HMAC of the body', () => {
    expect(webhookSignatureValid(secret, body, { 'x-chapa-signature': sign(secret, body) })).toBe(true);
    expect(webhookSignatureValid(secret, Buffer.from(body), { 'x-chapa-signature': sign(secret, body) })).toBe(true);
  });

  it('accepts chapa-signature: the HMAC of the secret', () => {
    expect(webhookSignatureValid(secret, body, { 'chapa-signature': sign(secret, secret) })).toBe(true);
  });

  it('accepts when only one of the two is right', () => {
    const headers = { 'x-chapa-signature': sign(secret, body), 'chapa-signature': 'f'.repeat(64) };
    expect(webhookSignatureValid(secret, body, headers)).toBe(true);
  });

  it.each([
    ['no signature', {}],
    ['a signature made with another secret', { 'x-chapa-signature': sign('another-secret', body) }],
    ['a signature of another body', { 'x-chapa-signature': sign(secret, body + ' ') }],
    ['a signature that is not hex', { 'x-chapa-signature': 'z'.repeat(64) }],
    ['a signature of the wrong length', { 'x-chapa-signature': sign(secret, body).slice(2) }],
    ['a signature that is not text', { 'x-chapa-signature': [sign(secret, body)] }],
  ])('refuses %s', (_name, headers) => {
    expect(webhookSignatureValid(secret, body, headers)).toBe(false);
  });

  it('refuses everything when no secret is configured', () => {
    expect(webhookSignatureValid('', body, { 'x-chapa-signature': sign('', body) })).toBe(false);
  });
});

describe('isTestKey', () => {
  it('recognises test secret keys only', () => {
    expect(isTestKey('CHASECK_TEST-abc')).toBe(true);
    expect(isTestKey('CHASECK-abc')).toBe(false);
    expect(isTestKey('CHAPUBK_TEST-abc')).toBe(false);
    expect(isTestKey('')).toBe(false);
  });
});

describe('isLocalHttpUrl', () => {
  it('is true only for plain http on this machine', () => {
    expect(isLocalHttpUrl('http://localhost:4010')).toBe(true);
    expect(isLocalHttpUrl('http://127.0.0.1:4010/checkout/x')).toBe(true);
    expect(isLocalHttpUrl('http://[::1]:4010')).toBe(true);
    expect(isLocalHttpUrl('https://localhost:4010')).toBe(false);
    expect(isLocalHttpUrl('http://localhost.evil.example')).toBe(false);
    expect(isLocalHttpUrl('http://evil.example/localhost')).toBe(false);
    expect(isLocalHttpUrl('http://localhost@evil.example')).toBe(false);
    expect(isLocalHttpUrl('http://192.168.1.10:4010')).toBe(false);
    expect(isLocalHttpUrl('not an address')).toBe(false);
  });
});

describe('checkoutUrlAllowed', () => {
  it('accepts https whether or not the simulator is in use', () => {
    expect(checkoutUrlAllowed('https://checkout.chapa.co/checkout/payment/abc', false)).toBe(true);
    expect(checkoutUrlAllowed('https://checkout.chapa.co/checkout/payment/abc', true)).toBe(true);
  });

  it('accepts a plain-http page on this machine only with the simulator', () => {
    expect(checkoutUrlAllowed('http://localhost:4010/checkout/abc', true)).toBe(true);
    expect(checkoutUrlAllowed('http://localhost:4010/checkout/abc', false)).toBe(false);
  });

  it('refuses everything else', () => {
    for (const simulator of [true, false]) {
      expect(checkoutUrlAllowed('http://checkout.chapa.co/x', simulator)).toBe(false);
      expect(checkoutUrlAllowed('javascript:alert(1)', simulator)).toBe(false);
      expect(checkoutUrlAllowed('//localhost:4010/x', simulator)).toBe(false);
      expect(checkoutUrlAllowed('', simulator)).toBe(false);
      expect(checkoutUrlAllowed(undefined, simulator)).toBe(false);
      expect(checkoutUrlAllowed(42, simulator)).toBe(false);
    }
  });
});
