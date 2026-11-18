import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeChapaTransaction {
  txRef: string;
  /** What our server sent when opening the payment. */
  request: Record<string, unknown>;
  authorization: string | undefined;
  /** What `verify` answers. Null: Chapa knows the reference but nothing has been paid. */
  verification: Record<string, unknown> | null;
}

/**
 * Stands in for api.chapa.co over real HTTP: the initialize and verify endpoints, with the answers documented at
 * https://developer.chapa.co. Tests decide what a payer "did" by calling pay/fail.
 */
export class FakeChapa {
  readonly transactions = new Map<string, FakeChapaTransaction>();
  /** Answer every request with HTTP 500, as during an outage. */
  down = false;
  /** Refuse to open new payments, with this message. */
  refuseInitialize: string | null = null;
  /** Transactions Chapa refuses to look up because they were opened with a key of the other mode. */
  readonly otherMode = new Set<string>();
  /** How a direct charge asks the payer to approve, as Chapa reports it. */
  chargeAuthType = 'ussd';
  initializeCalls = 0;
  chargeCalls = 0;
  /** The `type` query parameter of the last direct charge. */
  chargeType: string | null = null;
  verifyCalls = 0;
  private server!: Server;

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body }) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.transactions.clear();
    this.down = false;
    this.refuseInitialize = null;
    this.chargeAuthType = 'ussd';
    this.otherMode.clear();
    this.initializeCalls = 0;
    this.chargeCalls = 0;
    this.chargeType = null;
    this.verifyCalls = 0;
  }

  last(): FakeChapaTransaction {
    const all = [...this.transactions.values()];
    if (!all.length) throw new Error('No payment was opened at the fake Chapa');
    return all[all.length - 1];
  }

  /** A payment Chapa's inline service started from the payer's browser, which this server never sees. */
  inlineCharge(txRef: string, request: Record<string, unknown>): void {
    this.transactions.set(txRef, { txRef, request, authorization: undefined, verification: null });
  }

  /** The payer completed the payment. `changes` lets a test make Chapa report something other than what was asked. */
  pay(txRef: string, changes: Record<string, unknown> = {}): void {
    const tx = this.find(txRef);
    tx.verification = {
      first_name: tx.request.first_name ?? null,
      last_name: tx.request.last_name ?? null,
      email: tx.request.email ?? null,
      currency: tx.request.currency,
      amount: Number(tx.request.amount),
      charge: 3.5,
      mode: 'test',
      method: 'test',
      type: 'API',
      status: 'success',
      reference: `AP${txRef.slice(4, 14)}`,
      tx_ref: txRef,
      customization: tx.request.customization,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...changes,
    };
  }

  fail(txRef: string, status = 'failed'): void {
    this.pay(txRef, { status, reference: null });
  }

  private find(txRef: string): FakeChapaTransaction {
    const tx = this.transactions.get(txRef);
    if (!tx) throw new Error(`The fake Chapa has no transaction ${txRef}`);
    return tx;
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (this.down) return { status: 500, body: { message: 'Internal server error', status: 'failed', data: null } };

    if (req.method === 'POST' && path === '/v1/transaction/initialize') {
      this.initializeCalls += 1;
      if (this.refuseInitialize) {
        return { status: 400, body: { message: this.refuseInitialize, status: 'failed', data: null } };
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const txRef = String(request.tx_ref);
      if (this.transactions.has(txRef)) {
        return {
          status: 400,
          body: { message: 'Transaction reference has been used before', status: 'failed', data: null },
        };
      }
      this.transactions.set(txRef, { txRef, request, authorization: req.headers.authorization, verification: null });
      return {
        status: 200,
        body: {
          message: 'Hosted Link',
          status: 'success',
          data: { checkout_url: `https://checkout.chapa.co/checkout/payment/${txRef}` },
        },
      };
    }

    if (req.method === 'POST' && path === '/v1/charges') {
      this.chargeCalls += 1;
      this.chargeType = url.searchParams.get('type');
      if (this.refuseInitialize) {
        return { status: 400, body: { message: this.refuseInitialize, status: 'failed', data: null } };
      }
      // Like the real API, direct charges take multipart form data.
      const type = req.headers['content-type'] ?? '';
      if (!type.startsWith('multipart/form-data')) {
        return { status: 400, body: { message: 'Expected multipart form data', status: 'failed', data: null } };
      }
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData();
      const request = Object.fromEntries(
        [...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '']),
      ) as Record<string, unknown>;
      const txRef = String(request.tx_ref);
      this.transactions.set(txRef, { txRef, request, authorization: req.headers.authorization, verification: null });
      return {
        status: 200,
        body: {
          message: 'Charge initiated',
          status: 'success',
          data: {
            auth_type: this.chargeAuthType,
            meta: { message: 'Please approve on your phone', status: 'pending' },
          },
        },
      };
    }

    const verify = /^\/v1\/transaction\/verify\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && verify) {
      this.verifyCalls += 1;
      if (this.otherMode.has(decodeURIComponent(verify[1]))) {
        return {
          status: 401,
          body: { message: 'Secret key mode mismatch with transaction mode', status: 'failed', data: null },
        };
      }
      const tx = this.transactions.get(decodeURIComponent(verify[1]));
      if (!tx) {
        return {
          status: 404,
          body: { message: 'Invalid transaction or Transaction not found', status: 'failed', data: null },
        };
      }
      if (!tx.verification) {
        return {
          status: 200,
          body: {
            message: 'Payment details',
            status: 'success',
            data: {
              currency: tx.request.currency,
              amount: Number(tx.request.amount),
              mode: 'test',
              status: 'pending',
              reference: null,
              tx_ref: tx.txRef,
            },
          },
        };
      }
      return { status: 200, body: { message: 'Payment details', status: 'success', data: tx.verification } };
    }
    return { status: 404, body: { message: 'Not found' } };
  }
}
