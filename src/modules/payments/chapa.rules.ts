import { createHmac, timingSafeEqual } from 'node:crypto';

/** What Chapa says about one transaction, reduced to what a deposit needs. */
export type ChapaOutcome =
  | { state: 'paid'; reference: string | null }
  | { state: 'failed'; reason: string }
  | { state: 'pending' }
  /** Chapa reports a payment that is not the one we asked for. Never credited; a person must look. */
  | { state: 'mismatch'; reason: string };

export interface ExpectedPayment {
  txRef: string;
  amountMinor: bigint;
  currency: string;
  minorUnits: number;
  /** True when the secret key in use is a test key. */
  testMode: boolean;
}

/** Chapa's answer to `GET /transaction/verify/<tx_ref>`, as far as it is used here. Every field is untrusted input. */
export interface ChapaVerification {
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
  tx_ref?: unknown;
  mode?: unknown;
  reference?: unknown;
}

const FAILED_STATUSES = ['failed', 'cancelled', 'failed/cancelled', 'reversed', 'refunded'];

/** Turns a decimal amount such as `400`, `"400.00"` or `"12.5"` into minor units without floating point. Null if it is not one. */
export function decimalToMinor(value: unknown, minorUnits: number): bigint | null {
  const text = typeof value === 'number' ? value.toString() : typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > minorUnits && /[1-9]/.test(fraction.slice(minorUnits))) return null;
  return BigInt(match[1] + fraction.slice(0, minorUnits).padEnd(minorUnits, '0'));
}

/** Minor units as the decimal text Chapa expects, e.g. 12550 -> "125.50". */
export function minorToDecimal(amountMinor: bigint, minorUnits: number): string {
  if (minorUnits === 0) return amountMinor.toString();
  const digits = amountMinor.toString().padStart(minorUnits + 1, '0');
  return `${digits.slice(0, -minorUnits)}.${digits.slice(-minorUnits)}`;
}

/**
 * Decides whether a verified Chapa transaction may be credited. "Paid" needs every detail to match what was
 * asked for: a successful payment of another amount, currency, reference or mode is a mismatch, not a deposit.
 */
export function judgeVerification(data: ChapaVerification | null | undefined, expected: ExpectedPayment): ChapaOutcome {
  if (!data || typeof data.status !== 'string') return { state: 'pending' };
  const status = data.status.toLowerCase();
  if (FAILED_STATUSES.includes(status)) return { state: 'failed', reason: `Chapa reported the payment as ${status}` };
  if (status !== 'success') return { state: 'pending' };

  if (data.tx_ref !== expected.txRef) return { state: 'mismatch', reason: 'Chapa answered for another reference' };
  if (typeof data.currency !== 'string' || data.currency.toUpperCase() !== expected.currency) {
    return { state: 'mismatch', reason: `Paid in ${String(data.currency)}, expected ${expected.currency}` };
  }
  const paid = decimalToMinor(data.amount, expected.minorUnits);
  if (paid === null || paid !== expected.amountMinor) {
    return { state: 'mismatch', reason: `Paid amount ${String(data.amount)} is not the amount requested` };
  }
  const mode = typeof data.mode === 'string' ? data.mode.toLowerCase() : null;
  if (mode !== (expected.testMode ? 'test' : 'live')) {
    return { state: 'mismatch', reason: `Payment mode ${String(data.mode)} does not match the key in use` };
  }
  return { state: 'paid', reference: typeof data.reference === 'string' && data.reference ? data.reference : null };
}

const hmac = (secret: string, message: string | Buffer) => createHmac('sha256', secret).update(message).digest();

function matches(expected: Buffer, given: unknown): boolean {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/i.test(given)) return false;
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

/**
 * Chapa signs webhooks with the secret set in its dashboard: `x-chapa-signature` is the HMAC-SHA256 of the body,
 * `chapa-signature` the HMAC-SHA256 of the secret itself. Either one being right is enough.
 */
export function webhookSignatureValid(
  secret: string,
  rawBody: string | Buffer,
  headers: { 'x-chapa-signature'?: unknown; 'chapa-signature'?: unknown },
): boolean {
  if (!secret) return false;
  return (
    matches(hmac(secret, rawBody), headers['x-chapa-signature']) ||
    matches(hmac(secret, secret), headers['chapa-signature'])
  );
}

/** Test keys carry `_TEST` in their prefix, e.g. `CHASECK_TEST-…`. */
export const isTestKey = (secretKey: string): boolean => /^CHASECK_TEST/i.test(secretKey);

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** True for a plain-http address on this machine, which is where the local Chapa simulator runs. */
export function isLocalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Users are only ever sent to an https checkout page. The one exception is the local simulator: a plain-http
 * page on this machine, and only when the caller says the simulator is what is being talked to.
 */
export function checkoutUrlAllowed(value: unknown, simulator: boolean): value is string {
  if (typeof value !== 'string') return false;
  try {
    if (new URL(value).protocol === 'https:') return true;
  } catch {
    return false;
  }
  return simulator && isLocalHttpUrl(value);
}
