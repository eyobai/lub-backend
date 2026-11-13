import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ActorType, EntryDirection, LedgerAccountType, WalletTransactionType } from '@prisma/client';
import type { Currency, LedgerAccount, Prisma, Wallet } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { formatMinor } from '../../common/utils/money';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import type { PostingResult, Tx } from '../ledger/ledger.types';
import type {
  AdjustWalletDto,
  ListWalletTransactionsQueryDto,
  WalletDto,
  WalletTransactionDto,
  WalletTransactionPageDto,
} from './dto/wallet.dto';

const { DEBIT, CREDIT } = EntryDirection;

export interface WalletAccounts {
  wallet: Wallet;
  /** Spendable balance. */
  available: LedgerAccount;
  /** Money reserved for pending withdrawals. */
  hold: LedgerAccount;
}

/** A money movement requested by another module (payments, bidding). Amounts are bigint minor units. */
export interface WalletMovement {
  userId: string;
  amountMinor: bigint;
  /** Defaults to the platform currency. */
  currency?: string;
  /** Globally unique; namespace it by source, e.g. "payment:<provider>:<reference>". */
  idempotencyKey?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
  createdById?: string;
}

const entryInclude = {
  transaction: { include: { reverses: { select: { reference: true } } } },
} satisfies Prisma.LedgerEntryInclude;
type WalletEntry = Prisma.LedgerEntryGetPayload<{ include: typeof entryInclude }>;

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── Queries ────────────────────────────────────────────────────────────────

  async getWallet(userId: string, currencyCode?: string): Promise<WalletDto> {
    const currency = await this.resolveCurrency(currencyCode);
    return this.toWalletDto(await this.ensureWallet(userId, currency.code), currency);
  }

  /** The user's wallet history, newest first: one item per transaction that touched the spendable balance. */
  async listTransactions(userId: string, query: ListWalletTransactionsQueryDto): Promise<WalletTransactionPageDto> {
    const currency = await this.resolveCurrency(query.currency);
    const { available } = await this.ensureWallet(userId, currency.code);
    const limit = query.limit ?? 20;

    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        accountId: available.id,
        ...(query.cursor ? { sequence: { lt: BigInt(query.cursor) } } : {}),
        ...(query.type ? { transaction: { type: query.type } } : {}),
      },
      orderBy: { sequence: 'desc' },
      take: limit + 1,
      include: entryInclude,
    });
    const page = entries.slice(0, limit);
    return {
      items: page.map((e) => this.toTransactionDto(e, currency)),
      nextCursor: entries.length > limit ? page[page.length - 1].sequence.toString() : null,
    };
  }

  async getTransaction(userId: string, transactionId: string): Promise<WalletTransactionDto> {
    const entry = await this.prisma.ledgerEntry.findFirst({
      where: { transactionId, account: { type: LedgerAccountType.USER_WALLET, wallet: { userId } } },
      include: entryInclude,
    });
    // Someone else's transaction looks exactly like a missing one.
    if (!entry) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Transaction not found');
    return this.toTransactionDto(entry, await this.resolveCurrency(entry.transaction.currency, true));
  }

  // ── Money movements used by other modules ──────────────────────────────────

  /** Money received from a payment provider: payment clearing -> wallet. Called once a payment is confirmed. */
  deposit(movement: WalletMovement, tx?: Tx): Promise<PostingResult> {
    return this.move(WalletTransactionType.DEPOSIT, LedgerAccountType.PAYMENT_CLEARING, CREDIT, movement, tx);
  }

  /** Bid fee: wallet -> platform revenue. Fails with INSUFFICIENT_FUNDS or WALLET_FROZEN without moving money. */
  chargeBidFee(movement: WalletMovement, tx?: Tx): Promise<PostingResult> {
    return this.move(WalletTransactionType.BID_FEE, LedgerAccountType.PLATFORM_REVENUE, DEBIT, movement, tx);
  }

  /** Refund of fees already charged: platform revenue -> wallet. */
  refund(movement: WalletMovement, tx?: Tx): Promise<PostingResult> {
    return this.move(WalletTransactionType.REFUND, LedgerAccountType.PLATFORM_REVENUE, CREDIT, movement, tx);
  }

  // ── Administration ─────────────────────────────────────────────────────────

  async getWalletForAdmin(userId: string, currencyCode?: string): Promise<WalletDto> {
    await this.assertUserExists(userId);
    return this.getWallet(userId, currencyCode);
  }

  async listTransactionsForAdmin(
    userId: string,
    query: ListWalletTransactionsQueryDto,
  ): Promise<WalletTransactionPageDto> {
    await this.assertUserExists(userId);
    return this.listTransactions(userId, query);
  }

  /** Manual, audited correction of a user's balance against the ADJUSTMENTS account. */
  async adjust(
    actorId: string,
    userId: string,
    dto: AdjustWalletDto,
    idempotencyKey: string,
    client: ClientInfo,
  ): Promise<{ transaction: WalletTransactionDto; replayed: boolean }> {
    this.assertNotOwnWallet(actorId, userId);
    await this.assertUserExists(userId);
    const currency = await this.resolveCurrency(dto.currency);
    const amountMinor = BigInt(dto.amountMinor);

    return this.ledger.run(async (tx) => {
      const { wallet, available } = await this.ensureWallet(userId, currency.code, tx);
      const adjustments = await this.ledger.systemAccount(LedgerAccountType.ADJUSTMENTS, currency.code, tx);
      const result = await this.ledger.post(
        {
          type: WalletTransactionType.ADJUSTMENT,
          currency: currency.code,
          lines: [
            { accountId: available.id, direction: dto.direction, amountMinor },
            { accountId: adjustments.id, direction: dto.direction === CREDIT ? DEBIT : CREDIT, amountMinor },
          ],
          description: dto.reason,
          idempotencyKey: scopedKey('wallet.adjust', actorId, idempotencyKey),
          createdById: actorId,
          allowFrozenDebit: true,
        },
        tx,
      );
      if (!result.replayed) {
        const after = walletBalanceAfter(result, available.id);
        await this.audit.record(tx, {
          actorId,
          actorType: ActorType.ADMIN,
          action: 'wallet.adjust',
          entityType: 'wallet',
          entityId: wallet.id,
          // Derived from the ledger line written under the row lock, not from a possibly stale read.
          before: { availableMinor: (after + (dto.direction === CREDIT ? -amountMinor : amountMinor)).toString() },
          after: { availableMinor: after.toString() },
          metadata: {
            userId,
            transactionId: result.transaction.id,
            reference: result.transaction.reference,
            direction: dto.direction,
            amountMinor: dto.amountMinor,
            currency: currency.code,
            reason: dto.reason,
          },
          client,
        });
      }
      return { transaction: await this.entryDto(tx, result.transaction.id, currency), replayed: result.replayed };
    });
  }

  /** Reverses a manual adjustment. Other transaction types are undone by the module that created them. */
  async reverseAdjustment(
    actorId: string,
    transactionId: string,
    reason: string,
    idempotencyKey: string,
    client: ClientInfo,
  ): Promise<{ transaction: WalletTransactionDto; replayed: boolean }> {
    const original = await this.prisma.walletTransaction.findUnique({
      where: { id: transactionId },
      include: { entries: { include: { account: { include: { wallet: true } } } } },
    });
    if (!original) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Transaction not found');
    if (original.type !== WalletTransactionType.ADJUSTMENT) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.TRANSACTION_NOT_REVERSIBLE,
        'Only manual adjustments can be reversed here',
      );
    }
    const wallet = original.entries.find((e) => e.account.type === LedgerAccountType.USER_WALLET)?.account.wallet;
    if (!wallet) throw new Error(`Adjustment ${original.reference} has no wallet line`);
    this.assertNotOwnWallet(actorId, wallet.userId);
    const currency = await this.resolveCurrency(original.currency, true);

    return this.ledger.run(async (tx) => {
      const result = await this.ledger.reverse(
        transactionId,
        { reason, createdById: actorId, idempotencyKey: scopedKey('wallet.reverse', actorId, idempotencyKey) },
        tx,
      );
      if (!result.replayed) {
        await this.audit.record(tx, {
          actorId,
          actorType: ActorType.ADMIN,
          action: 'wallet.adjustment.reverse',
          entityType: 'wallet',
          entityId: wallet.id,
          metadata: {
            userId: wallet.userId,
            reversedTransactionId: original.id,
            reversedReference: original.reference,
            transactionId: result.transaction.id,
            reference: result.transaction.reference,
            reason,
          },
          client,
        });
      }
      return { transaction: await this.entryDto(tx, result.transaction.id, currency), replayed: result.replayed };
    });
  }

  /** Freezing blocks spending and withdrawals; incoming money is still credited. */
  async setFrozen(
    actorId: string,
    userId: string,
    frozen: boolean,
    reason: string,
    client: ClientInfo,
    currencyCode?: string,
  ): Promise<WalletDto> {
    await this.assertUserExists(userId);
    const currency = await this.resolveCurrency(currencyCode);

    return this.ledger.run(async (tx) => {
      const accounts = await this.ensureWallet(userId, currency.code, tx);
      // Same lock a posting takes: a debit either commits before the freeze or sees the frozen wallet.
      await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE id = ${accounts.available.id}::uuid FOR UPDATE`;
      const current = await tx.wallet.findUniqueOrThrow({ where: { id: accounts.wallet.id } });
      if (current.isFrozen !== frozen) {
        await tx.wallet.update({ where: { id: current.id }, data: { isFrozen: frozen } });
        await this.audit.record(tx, {
          actorId,
          actorType: ActorType.ADMIN,
          action: frozen ? 'wallet.freeze' : 'wallet.unfreeze',
          entityType: 'wallet',
          entityId: current.id,
          before: { isFrozen: current.isFrozen },
          after: { isFrozen: frozen },
          metadata: { userId, reason },
          client,
        });
      }
      return this.toWalletDto(await this.ensureWallet(userId, currency.code, tx), currency);
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Returns the user's wallet and its ledger accounts, creating them on first use. Safe under concurrency. */
  async ensureWallet(userId: string, currency: string, tx: Tx = this.prisma): Promise<WalletAccounts> {
    const find = () =>
      tx.wallet.findUnique({ where: { userId_currency: { userId, currency } }, include: { ledgerAccounts: true } });
    const pick = (found: NonNullable<Awaited<ReturnType<typeof find>>>): WalletAccounts | null => {
      const available = found.ledgerAccounts.find((a) => a.type === LedgerAccountType.USER_WALLET);
      const hold = found.ledgerAccounts.find((a) => a.type === LedgerAccountType.USER_WALLET_HOLD);
      return available && hold ? { wallet: found, available, hold } : null;
    };

    let found = await find();
    const ready = found && pick(found);
    if (ready) return ready;

    // ON CONFLICT DO NOTHING: two simultaneous first requests end up with the same single wallet.
    if (!found) {
      await tx.wallet.createMany({ data: [{ userId, currency }], skipDuplicates: true });
      found = await find();
      if (!found) throw new Error('Wallet could not be created');
    }
    await tx.ledgerAccount.createMany({
      data: [
        { code: `WALLET:${found.id}`, type: LedgerAccountType.USER_WALLET, currency, walletId: found.id },
        { code: `WALLET_HOLD:${found.id}`, type: LedgerAccountType.USER_WALLET_HOLD, currency, walletId: found.id },
      ],
      skipDuplicates: true,
    });
    const created = pick((await find())!);
    if (!created) throw new Error('Wallet ledger accounts could not be created');
    return created;
  }

  private async move(
    type: WalletTransactionType,
    counterpart: LedgerAccountType,
    walletSide: EntryDirection,
    movement: WalletMovement,
    tx?: Tx,
  ): Promise<PostingResult> {
    const currency = await this.resolveCurrency(movement.currency);
    return this.ledger.run(async (t) => {
      const { available } = await this.ensureWallet(movement.userId, currency.code, t);
      const other = await this.ledger.systemAccount(counterpart, currency.code, t);
      return this.ledger.post(
        {
          type,
          currency: currency.code,
          lines: [
            { accountId: available.id, direction: walletSide, amountMinor: movement.amountMinor },
            {
              accountId: other.id,
              direction: walletSide === CREDIT ? DEBIT : CREDIT,
              amountMinor: movement.amountMinor,
            },
          ],
          description: movement.description,
          metadata: movement.metadata,
          idempotencyKey: movement.idempotencyKey,
          createdById: movement.createdById,
        },
        t,
      );
    }, tx);
  }

  private async resolveCurrency(code?: string, allowInactive = false): Promise<Currency> {
    const wanted = (code ?? this.config.defaultCurrency).toUpperCase();
    const currency = await this.prisma.currency.findUnique({ where: { code: wanted } });
    if (!currency || (!currency.isActive && !allowInactive)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.CURRENCY_NOT_SUPPORTED,
        `Currency ${wanted} is not supported`,
      );
    }
    return currency;
  }

  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'User not found');
  }

  private assertNotOwnWallet(actorId: string, userId: string): void {
    if (actorId === userId) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'You cannot change the balance of your own wallet',
      );
    }
  }

  private async entryDto(tx: Tx, transactionId: string, currency: Currency): Promise<WalletTransactionDto> {
    const entry = await tx.ledgerEntry.findFirstOrThrow({
      where: { transactionId, account: { type: LedgerAccountType.USER_WALLET } },
      include: entryInclude,
    });
    return this.toTransactionDto(entry, currency);
  }

  private toWalletDto({ wallet, available, hold }: WalletAccounts, currency: Currency): WalletDto {
    return {
      id: wallet.id,
      userId: wallet.userId,
      currency: currency.code,
      minorUnits: currency.minorUnits,
      availableMinor: available.balanceMinor.toString(),
      available: formatMinor(available.balanceMinor, currency.minorUnits),
      heldMinor: hold.balanceMinor.toString(),
      held: formatMinor(hold.balanceMinor, currency.minorUnits),
      isFrozen: wallet.isFrozen,
      updatedAt: available.updatedAt > wallet.updatedAt ? available.updatedAt : wallet.updatedAt,
    };
  }

  private toTransactionDto(entry: WalletEntry, currency: Currency): WalletTransactionDto {
    const { transaction } = entry;
    return {
      id: transaction.id,
      reference: transaction.reference,
      type: transaction.type,
      status: transaction.status,
      direction: entry.direction,
      currency: transaction.currency,
      amountMinor: entry.amountMinor.toString(),
      amount: formatMinor(entry.amountMinor, currency.minorUnits),
      balanceAfterMinor: entry.balanceAfterMinor.toString(),
      balanceAfter: formatMinor(entry.balanceAfterMinor, currency.minorUnits),
      description: transaction.description,
      reversalOf: transaction.reverses?.reference ?? null,
      createdAt: transaction.createdAt,
    };
  }
}

/** Client keys are only unique per caller and operation, while the ledger's key is global: combine and hash. */
function scopedKey(scope: string, actorId: string, key: string): string {
  return createHash('sha256').update(`${scope}|${actorId}|${key}`).digest('hex');
}

function walletBalanceAfter(result: PostingResult, accountId: string): bigint {
  const entry = result.transaction.entries.find((e) => e.accountId === accountId);
  if (!entry) throw new Error('Posting has no line for the wallet account');
  return entry.balanceAfterMinor;
}
