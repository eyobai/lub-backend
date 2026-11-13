import { EntryDirection, LedgerAccountType, Prisma, WalletTransactionType } from '@prisma/client';
import type { LedgerEntry, WalletTransaction } from '@prisma/client';
import { MAX_AMOUNT_MINOR } from '../../common/utils/money';

export type Tx = Prisma.TransactionClient;

export interface PostingLine {
  accountId: string;
  direction: EntryDirection;
  amountMinor: bigint;
}

export interface PostingInput {
  type: WalletTransactionType;
  currency: string;
  /** Balanced set of lines: total debits must equal total credits. One line per account. */
  lines: PostingLine[];
  description?: string;
  metadata?: Prisma.InputJsonValue;
  /** Globally unique. Posting again with the same key returns the first journal instead of moving money twice. */
  idempotencyKey?: string;
  createdById?: string;
  reversesId?: string;
  /** Corrections and reversals may take money out of a frozen wallet; user-initiated spending may not. */
  allowFrozenDebit?: boolean;
}

export type PostedTransaction = WalletTransaction & { entries: LedgerEntry[] };

export interface PostingResult {
  transaction: PostedTransaction;
  /** True when the idempotency key had been used before and no money moved in this call. */
  replayed: boolean;
}

/**
 * Side on which an account's balance grows. Asset accounts are debit-normal; liabilities, income and the
 * adjustments account are credit-normal. A wallet is a liability: crediting it gives the user money.
 */
const DEBIT_NORMAL_TYPES: readonly LedgerAccountType[] = [LedgerAccountType.PAYMENT_CLEARING];

export const debitNormalTypes = (): string[] => [...DEBIT_NORMAL_TYPES];

export function normalSide(type: LedgerAccountType): EntryDirection {
  return DEBIT_NORMAL_TYPES.includes(type) ? EntryDirection.DEBIT : EntryDirection.CREDIT;
}

/** Signed change a line makes to its account's balance. */
export function balanceDelta(type: LedgerAccountType, line: Pick<PostingLine, 'direction' | 'amountMinor'>): bigint {
  return line.direction === normalSide(type) ? line.amountMinor : -line.amountMinor;
}

/**
 * Validates the shape of a journal before anything touches the database and returns its amount
 * (total debits). Throws plain Errors: a malformed posting is a programming mistake, not a user error.
 */
export function validateLines(lines: PostingLine[]): bigint {
  if (lines.length < 2) throw new Error('A ledger posting needs at least two lines');
  const accounts = new Set<string>();
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    if (typeof line.amountMinor !== 'bigint') throw new Error('Ledger amounts must be bigint minor units');
    if (line.amountMinor <= 0n) throw new Error('Ledger amounts must be positive');
    if (line.amountMinor > MAX_AMOUNT_MINOR) throw new Error('Ledger amount exceeds the supported maximum');
    if (accounts.has(line.accountId)) throw new Error('A ledger posting may reference each account only once');
    accounts.add(line.accountId);
    if (line.direction === EntryDirection.DEBIT) debits += line.amountMinor;
    else credits += line.amountMinor;
  }
  if (debits !== credits) throw new Error(`Unbalanced ledger posting: debits=${debits} credits=${credits}`);
  return debits;
}

/** Order-independent description of what a journal moves; used to detect idempotency-key misuse. */
export function fingerprint(
  type: WalletTransactionType,
  currency: string,
  lines: Pick<PostingLine, 'accountId' | 'direction' | 'amountMinor'>[],
): string {
  const parts = lines.map((l) => `${l.accountId}:${l.direction}:${l.amountMinor}`).sort();
  return [type, currency, ...parts].join('|');
}
