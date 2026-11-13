import { EntryDirection, LedgerAccountType, WalletTransactionType } from '@prisma/client';
import { balanceDelta, fingerprint, normalSide, validateLines } from './ledger.types';

const { DEBIT, CREDIT } = EntryDirection;
const line = (accountId: string, direction: EntryDirection, amountMinor: bigint) => ({
  accountId,
  direction,
  amountMinor,
});

describe('validateLines', () => {
  it('returns the journal amount for a balanced posting', () => {
    expect(validateLines([line('a', DEBIT, 500n), line('b', CREDIT, 500n)])).toBe(500n);
    expect(validateLines([line('a', DEBIT, 500n), line('b', CREDIT, 450n), line('c', CREDIT, 50n)])).toBe(500n);
  });

  it.each([
    ['a single line', [line('a', DEBIT, 500n)], /at least two lines/],
    ['unbalanced lines', [line('a', DEBIT, 500n), line('b', CREDIT, 499n)], /Unbalanced/],
    ['a zero amount', [line('a', DEBIT, 0n), line('b', CREDIT, 0n)], /positive/],
    ['a negative amount', [line('a', DEBIT, -5n), line('b', CREDIT, -5n)], /positive/],
    ['an oversized amount', [line('a', DEBIT, 10n ** 16n), line('b', CREDIT, 10n ** 16n)], /maximum/],
    ['a repeated account', [line('a', DEBIT, 5n), line('a', CREDIT, 5n)], /only once/],
    [
      'a non-bigint amount',
      [line('a', DEBIT, 5 as unknown as bigint), line('b', CREDIT, 5 as unknown as bigint)],
      /bigint/,
    ],
  ])('rejects %s', (_name, lines, message) => {
    expect(() => validateLines(lines)).toThrow(message);
  });
});

describe('account sides', () => {
  it('treats wallets, revenue and adjustments as credit-normal and payment clearing as debit-normal', () => {
    expect(normalSide(LedgerAccountType.USER_WALLET)).toBe(CREDIT);
    expect(normalSide(LedgerAccountType.USER_WALLET_HOLD)).toBe(CREDIT);
    expect(normalSide(LedgerAccountType.PLATFORM_REVENUE)).toBe(CREDIT);
    expect(normalSide(LedgerAccountType.ADJUSTMENTS)).toBe(CREDIT);
    expect(normalSide(LedgerAccountType.PAYMENT_CLEARING)).toBe(DEBIT);
  });

  it('credits increase a wallet and debits decrease it', () => {
    expect(balanceDelta(LedgerAccountType.USER_WALLET, { direction: CREDIT, amountMinor: 70n })).toBe(70n);
    expect(balanceDelta(LedgerAccountType.USER_WALLET, { direction: DEBIT, amountMinor: 70n })).toBe(-70n);
    expect(balanceDelta(LedgerAccountType.PAYMENT_CLEARING, { direction: DEBIT, amountMinor: 70n })).toBe(70n);
  });
});

describe('fingerprint', () => {
  it('ignores line order but not content', () => {
    const a = [line('a', DEBIT, 5n), line('b', CREDIT, 5n)];
    const type = WalletTransactionType.DEPOSIT;
    expect(fingerprint(type, 'ETB', a)).toBe(fingerprint(type, 'ETB', [...a].reverse()));
    expect(fingerprint(type, 'ETB', a)).not.toBe(
      fingerprint(type, 'ETB', [line('a', DEBIT, 6n), line('b', CREDIT, 6n)]),
    );
    expect(fingerprint(type, 'ETB', a)).not.toBe(fingerprint(WalletTransactionType.REFUND, 'ETB', a));
  });
});
