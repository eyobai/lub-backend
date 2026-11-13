import { HttpStatus, Injectable } from '@nestjs/common';
import { EntryDirection, LedgerAccountType, WalletTransactionStatus } from '@prisma/client';
import type { LedgerAccount } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { balanceDelta, fingerprint, validateLines } from './ledger.types';
import type { PostedTransaction, PostingInput, PostingResult, Tx } from './ledger.types';

/** Financial transactions may queue behind a row lock, so they get more room than Prisma's 5 s default. */
export const LEDGER_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/** System accounts whose balance may legitimately fall below zero. */
const ALLOW_NEGATIVE: readonly LedgerAccountType[] = [
  LedgerAccountType.PAYMENT_CLEARING,
  LedgerAccountType.ADJUSTMENTS,
];

const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

interface LockedAccount {
  id: string;
  code: string;
  type: LedgerAccountType;
  currency: string;
  wallet_id: string | null;
  allow_negative: boolean;
  balance_minor: bigint;
}

export interface ReverseOptions {
  reason: string;
  createdById?: string;
  idempotencyKey?: string;
}

/**
 * The only code path that moves money. Every movement is one journal (wallet_transactions) with balanced
 * debit/credit lines (ledger_entries); cached account balances change in the same database transaction.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Runs `fn` in a database transaction suited to ledger work, or inside the caller's transaction if given. */
  run<T>(fn: (tx: Tx) => Promise<T>, tx?: Tx): Promise<T> {
    return tx ? fn(tx) : this.prisma.$transaction(fn, LEDGER_TX_OPTIONS);
  }

  /** Posts a balanced journal atomically. Pass `tx` to make it part of a larger unit of work (e.g. a bid). */
  post(input: PostingInput, tx?: Tx): Promise<PostingResult> {
    return this.run((t) => this.postIn(t, input), tx);
  }

  /** Returns the platform-level account of the given type, creating it on first use. */
  async systemAccount(type: LedgerAccountType, currency: string, tx: Tx): Promise<LedgerAccount> {
    if (type === LedgerAccountType.USER_WALLET || type === LedgerAccountType.USER_WALLET_HOLD) {
      throw new Error(`${type} is a per-wallet account, not a system account`);
    }
    const code = `${type}:${currency}`;
    const existing = await tx.ledgerAccount.findUnique({ where: { code } });
    if (existing) return existing;
    // ON CONFLICT DO NOTHING: safe when two requests create the account at the same moment.
    await tx.ledgerAccount.createMany({
      data: [{ code, type, currency, allowNegative: ALLOW_NEGATIVE.includes(type) }],
      skipDuplicates: true,
    });
    return tx.ledgerAccount.findUniqueOrThrow({ where: { code } });
  }

  /**
   * Undoes a journal by posting its mirror image; the original lines are never edited or deleted.
   * A journal can be reversed once, and a reversal cannot itself be reversed.
   */
  reverse(transactionId: string, options: ReverseOptions, tx?: Tx): Promise<PostingResult> {
    return this.run(async (t) => {
      if (options.idempotencyKey) {
        const earlier = await this.findByIdempotencyKey(t, options.idempotencyKey);
        if (earlier) {
          if (earlier.reversesId !== transactionId) throw this.keyReused();
          return { transaction: earlier, replayed: true };
        }
      }

      // Serializes concurrent reversals of the same journal.
      await t.$queryRaw`SELECT id FROM wallet_transactions WHERE id = ${transactionId}::uuid FOR UPDATE`;
      const original = await t.walletTransaction.findUnique({
        where: { id: transactionId },
        include: { entries: true },
      });
      if (!original) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Transaction not found');
      if (original.status === WalletTransactionStatus.REVERSED) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.TRANSACTION_ALREADY_REVERSED,
          'This transaction has already been reversed',
        );
      }
      if (original.reversesId) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.TRANSACTION_NOT_REVERSIBLE,
          'A reversal cannot be reversed. Post a new correction instead.',
        );
      }

      const result = await this.postIn(t, {
        type: original.type,
        currency: original.currency,
        lines: original.entries.map((e) => ({
          accountId: e.accountId,
          direction: e.direction === EntryDirection.DEBIT ? EntryDirection.CREDIT : EntryDirection.DEBIT,
          amountMinor: e.amountMinor,
        })),
        description: `Reversal of ${original.reference}: ${options.reason}`,
        metadata: { reversedReference: original.reference, reason: options.reason },
        idempotencyKey: options.idempotencyKey,
        createdById: options.createdById,
        reversesId: original.id,
        allowFrozenDebit: true,
      });
      await t.walletTransaction.update({
        where: { id: original.id },
        data: { status: WalletTransactionStatus.REVERSED },
      });
      return result;
    }, tx);
  }

  private async postIn(tx: Tx, input: PostingInput): Promise<PostingResult> {
    const amountMinor = validateLines(input.lines);

    if (input.idempotencyKey) {
      const earlier = await this.findByIdempotencyKey(tx, input.idempotencyKey);
      if (earlier) {
        const same =
          fingerprint(earlier.type, earlier.currency, earlier.entries) ===
          fingerprint(input.type, input.currency, input.lines);
        if (!same) throw this.keyReused();
        return { transaction: earlier, replayed: true };
      }
    }

    const accounts = await this.lockAccounts(
      tx,
      input.lines.map((l) => l.accountId),
    );
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const debitedWalletIds: string[] = [];
    const updates = input.lines.map((line) => {
      const account = byId.get(line.accountId);
      if (!account) throw new Error(`Ledger account ${line.accountId} does not exist`);
      if (account.currency !== input.currency) {
        throw new Error(`Ledger account ${account.code} is in ${account.currency}, not ${input.currency}`);
      }
      const delta = balanceDelta(account.type, line);
      const balanceAfter = account.balance_minor + delta;
      if (account.type === LedgerAccountType.USER_WALLET && delta < 0n && account.wallet_id) {
        debitedWalletIds.push(account.wallet_id);
      }
      if (balanceAfter < 0n && !account.allow_negative) {
        if (account.type === LedgerAccountType.USER_WALLET) {
          throw new AppException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ErrorCode.INSUFFICIENT_FUNDS,
            'Insufficient wallet balance',
            {
              currency: account.currency,
              requiredMinor: line.amountMinor.toString(),
              availableMinor: account.balance_minor.toString(),
            },
          );
        }
        throw new Error(`Posting would make ledger account ${account.code} negative`);
      }
      return { line, account, balanceAfter };
    });

    if (debitedWalletIds.length && !input.allowFrozenDebit) {
      // Read after the account locks are held: freezing takes the same lock, so this cannot be stale.
      const frozen = await tx.wallet.count({ where: { id: { in: debitedWalletIds }, isFrozen: true } });
      if (frozen) {
        throw new AppException(
          HttpStatus.FORBIDDEN,
          ErrorCode.WALLET_FROZEN,
          'This wallet is frozen. Contact support.',
        );
      }
    }

    const transaction = await tx.walletTransaction.create({
      data: {
        reference: newReference(),
        type: input.type,
        currency: input.currency,
        amountMinor,
        description: input.description,
        metadata: input.metadata,
        idempotencyKey: input.idempotencyKey,
        createdById: input.createdById,
        reversesId: input.reversesId,
      },
    });
    await tx.ledgerEntry.createMany({
      data: updates.map(({ line, balanceAfter }) => ({
        transactionId: transaction.id,
        accountId: line.accountId,
        direction: line.direction,
        amountMinor: line.amountMinor,
        balanceAfterMinor: balanceAfter,
      })),
    });
    for (const { account, balanceAfter } of updates) {
      await tx.ledgerAccount.update({
        where: { id: account.id },
        data: { balanceMinor: balanceAfter, version: { increment: 1 } },
      });
    }

    const entries = await tx.ledgerEntry.findMany({
      where: { transactionId: transaction.id },
      orderBy: { sequence: 'asc' },
    });
    return { transaction: { ...transaction, entries }, replayed: false };
  }

  /**
   * Row-locks the accounts in a fixed (id) order so concurrent postings queue instead of deadlocking,
   * and returns their current balances.
   */
  private lockAccounts(tx: Tx, accountIds: string[]): Promise<LockedAccount[]> {
    return tx.$queryRaw<LockedAccount[]>`
      SELECT id, code, type, currency, wallet_id, allow_negative, balance_minor
      FROM ledger_accounts
      WHERE id = ANY(${accountIds}::uuid[])
      ORDER BY id
      FOR UPDATE`;
  }

  /** Takes a per-key lock for the rest of the transaction, then looks the key up: same-key requests run one at a time. */
  private async findByIdempotencyKey(tx: Tx, key: string): Promise<PostedTransaction | null> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
    return tx.walletTransaction.findUnique({
      where: { idempotencyKey: key },
      include: { entries: { orderBy: { sequence: 'asc' } } },
    });
  }

  private keyReused(): AppException {
    return new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      'This idempotency key was already used for a different request',
    );
  }
}

/** Human-readable journal reference, e.g. "TX-20261113-7K2M9QXA4T". */
function newReference(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Array.from(randomBytes(10), (b) => REFERENCE_ALPHABET[b % 32]).join('');
  return `TX-${day}-${random}`;
}
