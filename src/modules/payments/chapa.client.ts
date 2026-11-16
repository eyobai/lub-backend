import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import type { ChapaVerification } from './chapa.rules';

export interface ChapaInitializeInput {
  txRef: string;
  /** Decimal text, e.g. "125.50". */
  amount: string;
  currency: string;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  returnUrl: string;
  callbackUrl?: string;
  title: string;
  description: string;
}

/** Chapa could not be reached or gave an answer that cannot be used. `refused` means Chapa itself said no. */
export class ChapaError extends Error {
  constructor(
    message: string,
    readonly refused: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

interface ChapaEnvelope {
  status?: unknown;
  message?: unknown;
  data?: unknown;
}

/** The only code that talks to Chapa. See https://developer.chapa.co/integrations/accept-payments */
@Injectable()
export class ChapaClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Opens a transaction and returns the address of Chapa's checkout page for it. */
  async initialize(input: ChapaInitializeInput): Promise<{ checkoutUrl: string }> {
    const { status, body } = await this.request('POST', '/v1/transaction/initialize', {
      amount: input.amount,
      currency: input.currency,
      tx_ref: input.txRef,
      phone_number: input.phoneNumber,
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      return_url: input.returnUrl,
      callback_url: input.callbackUrl,
      customization: { title: input.title, description: input.description },
    });
    const data = body.data as { checkout_url?: unknown } | null | undefined;
    const url = typeof data?.checkout_url === 'string' ? data.checkout_url : '';
    if (status >= 200 && status < 300 && /^https:\/\//.test(url)) return { checkoutUrl: url };
    throw new ChapaError(`Chapa did not open the transaction: ${describe(body.message)}`, status < 500, status);
  }

  /** Asks Chapa for the current state of a transaction. Null when Chapa does not know the reference (yet). */
  async verify(txRef: string): Promise<ChapaVerification | null> {
    const { status, body } = await this.request('GET', `/v1/transaction/verify/${encodeURIComponent(txRef)}`);
    if (status >= 200 && status < 300 && body.data && typeof body.data === 'object') {
      return body.data;
    }
    if (status === 401 || status === 403 || status >= 500) {
      throw new ChapaError(`Chapa could not verify the transaction: ${describe(body.message)}`, false, status);
    }
    return null;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: ChapaEnvelope }> {
    const { secretKey, baseUrl, timeoutMs } = this.config.payments.chapa;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: 'application/json',
          ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new ChapaError(`Chapa could not be reached: ${error instanceof Error ? error.name : 'error'}`, false);
    }
    const text = await response.text().catch(() => '');
    let body: ChapaEnvelope = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') body = parsed;
    } catch {
      // Not JSON (an error page from a proxy, for example): treated as an answer without content.
    }
    return { status: response.status, body };
  }
}

/** Chapa's `message` is sometimes text and sometimes an object of field errors. Kept short: it goes into logs and records. */
function describe(message: unknown): string {
  const text = typeof message === 'string' ? message : JSON.stringify(message ?? 'no message');
  return text.slice(0, 300);
}
