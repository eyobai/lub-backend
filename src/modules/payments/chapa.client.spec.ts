import type { AppConfig } from '../../config/configuration';
import { ChapaClient, ChapaError } from './chapa.client';

const config = {
  payments: {
    chapa: { secretKey: 'CHASECK_TEST-unit', webhookSecret: 'x', baseUrl: 'https://chapa.test', timeoutMs: 2000 },
  },
} as AppConfig;

const input = {
  txRef: 'LUB-0123456789ABCDEFGHJK',
  amount: '125.50',
  currency: 'ETB',
  phoneNumber: '0911223344',
  firstName: 'Abebe',
  lastName: 'Kebede',
  returnUrl: 'https://site.test/wallet/deposits/1',
  callbackUrl: 'https://api.test/api/v1/payments/chapa/callback',
  title: 'LUB Auction',
  description: 'Wallet deposit',
};

describe('ChapaClient', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const client = new ChapaClient(config);
  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('initialize', () => {
    it('posts the transaction with the secret key and returns the checkout address', async () => {
      answer(200, { status: 'success', data: { checkout_url: 'https://checkout.chapa.co/checkout/payment/abc' } });

      await expect(client.initialize(input)).resolves.toEqual({
        checkoutUrl: 'https://checkout.chapa.co/checkout/payment/abc',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://chapa.test/v1/transaction/initialize');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer CHASECK_TEST-unit',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        amount: '125.50',
        currency: 'ETB',
        tx_ref: 'LUB-0123456789ABCDEFGHJK',
        phone_number: '0911223344',
        first_name: 'Abebe',
        last_name: 'Kebede',
        return_url: 'https://site.test/wallet/deposits/1',
        callback_url: 'https://api.test/api/v1/payments/chapa/callback',
        customization: { title: 'LUB Auction', description: 'Wallet deposit' },
      });
    });

    it('leaves out details that are not known', async () => {
      answer(200, { status: 'success', data: { checkout_url: 'https://checkout.chapa.co/x' } });
      await client.initialize({ ...input, phoneNumber: undefined, firstName: undefined, callbackUrl: undefined });
      const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>;
      expect(sent).not.toHaveProperty('phone_number');
      expect(sent).not.toHaveProperty('first_name');
      expect(sent).not.toHaveProperty('callback_url');
    });

    it('reports a refusal from Chapa, with its message, as refused', async () => {
      answer(400, { status: 'failed', message: { amount: ['The amount must be at least 1.'] }, data: null });
      const error = await client.initialize(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChapaError);
      expect(error).toMatchObject({ refused: true, httpStatus: 400 });
      expect((error as ChapaError).message).toContain('The amount must be at least 1.');
    });

    it.each([
      ['no checkout address', { status: 'success', data: {} }],
      ['a checkout address that is not https', { status: 'success', data: { checkout_url: 'http://evil.test/pay' } }],
      ['a checkout address that is not a web address', { status: 'success', data: { checkout_url: 'javascript:1' } }],
    ])('does not accept a success with %s', async (_name, body) => {
      answer(200, body);
      await expect(client.initialize(input)).rejects.toBeInstanceOf(ChapaError);
    });

    describe('with the local simulator', () => {
      const local = 'http://localhost:4010/checkout/LUB-0123456789ABCDEFGHJK';
      const withBase = (env: AppConfig['env'], baseUrl: string) =>
        new ChapaClient({ env, payments: { chapa: { ...config.payments.chapa, baseUrl } } } as AppConfig);

      it('accepts a plain-http checkout page on this machine', async () => {
        answer(200, { status: 'success', data: { checkout_url: local } });
        await expect(withBase('development', 'http://localhost:4010').initialize(input)).resolves.toEqual({
          checkoutUrl: local,
        });
      });

      it('still refuses a plain-http page anywhere else', async () => {
        answer(200, { status: 'success', data: { checkout_url: 'http://evil.test/pay' } });
        await expect(withBase('development', 'http://localhost:4010').initialize(input)).rejects.toBeInstanceOf(
          ChapaError,
        );
      });

      it('refuses the local page when Chapa itself is the provider', async () => {
        answer(200, { status: 'success', data: { checkout_url: local } });
        await expect(withBase('development', 'https://api.chapa.co').initialize(input)).rejects.toBeInstanceOf(
          ChapaError,
        );
      });

      it('refuses the local page in production', async () => {
        answer(200, { status: 'success', data: { checkout_url: local } });
        await expect(withBase('production', 'http://localhost:4010').initialize(input)).rejects.toBeInstanceOf(
          ChapaError,
        );
      });
    });

    it('reports a Chapa outage as not refused', async () => {
      answer(502, '<html>Bad gateway</html>');
      await expect(client.initialize(input)).rejects.toMatchObject({ refused: false, httpStatus: 502 });
    });

    it('reports a network failure without leaking the key', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed for Bearer CHASECK_TEST-unit'));
      const error = (await client.initialize(input).catch((e: unknown) => e)) as ChapaError;
      expect(error).toBeInstanceOf(ChapaError);
      expect(error.refused).toBe(false);
      expect(error.message).not.toContain('CHASECK');
    });
  });

  describe('verify', () => {
    it('asks for the reference and returns what Chapa knows', async () => {
      const data = { status: 'success', amount: 125.5, currency: 'ETB', tx_ref: input.txRef, mode: 'test' };
      answer(200, { status: 'success', message: 'Payment details', data });

      await expect(client.verify(input.txRef)).resolves.toEqual(data);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://chapa.test/v1/transaction/verify/LUB-0123456789ABCDEFGHJK');
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer CHASECK_TEST-unit' });
    });

    it('escapes the reference in the address', async () => {
      answer(404, {});
      await client.verify('a/b?c');
      expect(fetchMock.mock.calls[0][0]).toBe('https://chapa.test/v1/transaction/verify/a%2Fb%3Fc');
    });

    it.each([
      [404, { status: 'failed', message: 'Invalid transaction or Transaction not found', data: null }],
      [400, { status: 'failed', message: 'Payment not paid yet', data: null }],
      [200, { status: 'success', data: null }],
      [200, 'not json'],
    ])('answers null when Chapa has nothing usable (%s)', async (status, body) => {
      answer(status, body);
      await expect(client.verify(input.txRef)).resolves.toBeNull();
    });

    it.each([401, 403, 500, 503])('fails on HTTP %s, so the caller tries again later', async (status) => {
      answer(status, { message: 'nope' });
      await expect(client.verify(input.txRef)).rejects.toMatchObject({ refused: false, httpStatus: status });
    });

    it('fails when Chapa cannot be reached', async () => {
      fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
      await expect(client.verify(input.txRef)).rejects.toBeInstanceOf(ChapaError);
    });
  });
});
