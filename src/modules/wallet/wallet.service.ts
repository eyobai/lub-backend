import { HttpStatus, Injectable } from '@nestjs/common';
import { ActorType, EntryDirection, LedgerAccountType, WalletTransactionType } from '@prisma/client';
import type { Currency, LedgerAccount, Prisma, Wallet } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { formatMinor } from '../../common/utils/money';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrencyService } from '../currency/currency.service';
import { LedgerService } from '../ledger/ledger.service';
import { walletCredited } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
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
  /** Top-up bonus: spent on bid fees before the spendable balance, never withdrawable, expires. */
  bonus: LedgerAccount;
}

/** A top-up bonus to give, once the top-up it rewards is confirmed. */
export interface BonusGrant {
  userId: string;
  currency: string;
  amountMinor: bigint;
  expiresAt: Date;
  paymentTransactionId: string;
  /** Globally unique, e.g. "bonus:payment:<reference>". */
  idempotencyKey: string;
}

/** What a wallet can spend on bid fees right now. */
export interface SpendableBalance {
  availableMinor: bigint;
  /** Bonus that has not expired. */
  bonusMinor: bigint;
  /** When the bonus that expires first does so; null without bonus. */
  bonusExpiresAt: Date | null;
}

/** How a bid fee was paid, kept on its journal so a refund can give each part back where it came from. */
interface BonusUse {
  bonusMinor: string;
  bonusGrants: { id: string; minor: string }[];
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
  account: { select: { type: true } },
} satisfies Prisma.LedgerEntryInclude;
type WalletEntry = Prisma.LedgerEntryGetPayload<{ include: typeof entryInclude }>;

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly currencies: CurrencyService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Queries ────────────────────────────────────────────────────────────────

  async getWallet(userId: string, currencyCode?: string): Promise<WalletDto> {
    const currency = await this.resolveCurrency(currencyCode);
    return this.toWalletDto(await this.ensureWallet(userId, currency.code), currency);
  }

  /** Balance and live bonus of a wallet, for checks and answers. Pass `tx` to read inside a unit of work. */
  async spendable(userId: string, currency: string, tx: Tx = this.prisma): Promise<SpendableBalance> {
    const { wallet, available } = await this.ensureWallet(userId, currency, tx);
    const live = await tx.walletBonusGrant.aggregate({
      where: {
        walletId: wallet.id,
        remainingMinor: { gt: 0 },
        expiresAt: { gt: new Date() },
        expiryTransactionId: null,
      },
      _sum: { remainingMinor: true },
      _min: { expiresAt: true },
    });
    return {
      availableMinor: available.balanceMinor,
      bonusMinor: live._sum.remainingMinor ?? 0n,
      bonusExpiresAt: live._min.expiresAt ?? null,
    };
  }

  /**
   * The user's wallet history, newest first: one item per movement of the spendable balance or the bonus. A bid
   * fee paid partly with bonus shows as two items, each marked with the balance it came from.
   */
  async listTransactions(userId: string, query: ListWalletTransactionsQueryDto): Promise<WalletTransactionPageDto> {
    const currency = await this.resolveCurrency(query.currency);
    const { available, bonus } = await this.ensureWallet(userId, currency.code);
    const limit = query.limit ?? 20;

    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        accountId: { in: [available.id, bonus.id] },
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
      where: {
        transactionId,
        account: {
          type: { in: [LedgerAccountType.USER_WALLET, LedgerAccountType.USER_WALLET_BONUS] },
          wallet: { userId },
        },
      },
      orderBy: { sequence: 'asc' },
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

  /**
   * Bid fee: wallet -> platform revenue, live bonus first (the one expiring soonest first), then the spendable
   * balance. Fails with INSUFFICIENT_FUNDS or WALLET_FROZEN without moving money.
   */
  chargeBidFee(movement: WalletMovement, tx?: Tx): Promise<PostingResult> {
    return this.ledger.run(async (t) => {
      const currency = await this.currencies.resolve(movement.currency, false, t);
      const earlier = await this.replayed(t, movement.idempotencyKey);
      if (earlier) return earlier;
      const { wallet, available, bonus } = await this.ensureWallet(movement.userId, currency.code, t);
      const revenue = await this.ledger.systemAccount(LedgerAccountType.PLATFORM_REVENUE, currency.code, t);
      // Grants are locked before ledger accounts, in that order wherever bonus moves (spend, refund, expiry).
      const grants = await t.$queryRaw<{ id: string; remaining_minor: bigint }[]>`
        SELECT id, remaining_minor FROM wallet_bonus_grants
        WHERE wallet_id = ${wallet.id}::uuid AND remaining_minor > 0
          AND expires_at > clock_timestamp() AND expiry_transaction_id IS NULL
        ORDER BY expires_at, id
        FOR UPDATE`;
      const used: { id: string; minor: bigint }[] = [];
      let cashMinor = movement.amountMinor;
      for (const grant of grants) {
        if (cashMinor === 0n) break;
        const take = grant.remaining_minor < cashMinor ? grant.remaining_minor : cashMinor;
        used.push({ id: grant.id, minor: take });
        cashMinor -= take;
      }
      const bonusMinor = movement.amountMinor - cashMinor;
      const use: BonusUse = {
        bonusMinor: bonusMinor.toString(),
        bonusGrants: used.map((u) => ({ id: u.id, minor: u.minor.toString() })),
      };
      let result: PostingResult;
      try {
        result = await this.ledger.post(
          {
            type: WalletTransactionType.BID_FEE,
            currency: currency.code,
            lines: [
              ...(bonusMinor > 0n ? [{ accountId: bonus.id, direction: DEBIT, amountMinor: bonusMinor }] : []),
              ...(cashMinor > 0n ? [{ accountId: available.id, direction: DEBIT, amountMinor: cashMinor }] : []),
              { accountId: revenue.id, direction: CREDIT, amountMinor: movement.amountMinor },
            ],
            description: movement.description,
            metadata: withBonusUse(movement.metadata, use),
            idempotencyKey: movement.idempotencyKey,
            createdById: movement.createdById,
          },
          t,
        );
      } catch (error) {
        // The ledger only saw the cash part; the bidder is told about all they could spend.
        if (error instanceof AppException && error.code === ErrorCode.INSUFFICIENT_FUNDS) {
          throw new AppException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ErrorCode.INSUFFICIENT_FUNDS,
            'Insufficient wallet balance',
            {
              currency: currency.code,
              requiredMinor: movement.amountMinor.toString(),
              availableMinor: (available.balanceMinor + bonusMinor).toString(),
            },
          );
        }
        throw error;
      }
      for (const u of used) {
        await t.walletBonusGrant.update({ where: { id: u.id }, data: { remainingMinor: { decrement: u.minor } } });
      }
      return result;
    }, tx);
  }

  /** A plain refund to the spendable balance: platform revenue -> wallet. Bid fees use {@link refundBidFee}. */
  refund(movement: WalletMovement, tx?: Tx): Promise<PostingResult> {
    return this.move(WalletTransactionType.REFUND, LedgerAccountType.PLATFORM_REVENUE, CREDIT, movement, tx);
  }

  /**
   * Refund of a bid fee: platform revenue -> wallet, each part back where it came from. Cash goes to the spendable
   * balance; bonus goes back to the grant it was taken from while that grant is live, and otherwise to PROMOTIONS,
   * as if it had expired unspent.
   */
  refundBidFee(chargeTransactionId: string, movement: WalletMovement, tx?: Tx): Promise<PostingResult> {
    return this.ledger.run(async (t) => {
      const currency = await this.currencies.resolve(movement.currency, false, t);
      const earlier = await this.replayed(t, movement.idempotencyKey);
      if (earlier) return earlier;
      const charge = await t.walletTransaction.findUniqueOrThrow({ where: { id: chargeTransactionId } });
      const use = readBonusUse(charge.metadata);
      const ids = use.bonusGrants.map((g) => g.id);
      const live = ids.length
        ? await t.$queryRaw<{ id: string }[]>`
            SELECT id FROM wallet_bonus_grants
            WHERE id = ANY(${ids}::uuid[]) AND expires_at > clock_timestamp() AND expiry_transaction_id IS NULL
            ORDER BY expires_at, id
            FOR UPDATE`
        : [];
      const liveIds = new Set(live.map((g) => g.id));
      const restore = use.bonusGrants.filter((g) => liveIds.has(g.id));
      const toBonus = restore.reduce((sum, g) => sum + BigInt(g.minor), 0n);
      const toPromotions = BigInt(use.bonusMinor) - toBonus;
      const toCash = movement.amountMinor - BigInt(use.bonusMinor);

      const { available, bonus } = await this.ensureWallet(movement.userId, currency.code, t);
      const revenue = await this.ledger.systemAccount(LedgerAccountType.PLATFORM_REVENUE, currency.code, t);
      const promotions =
        toPromotions > 0n ? await this.ledger.systemAccount(LedgerAccountType.PROMOTIONS, currency.code, t) : null;
      const result = await this.ledger.post(
        {
          type: WalletTransactionType.REFUND,
          currency: currency.code,
          lines: [
            { accountId: revenue.id, direction: DEBIT, amountMinor: movement.amountMinor },
            ...(toCash > 0n ? [{ accountId: available.id, direction: CREDIT, amountMinor: toCash }] : []),
            ...(toBonus > 0n ? [{ accountId: bonus.id, direction: CREDIT, amountMinor: toBonus }] : []),
            ...(promotions ? [{ accountId: promotions.id, direction: CREDIT, amountMinor: toPromotions }] : []),
          ],
          description: movement.description,
          metadata: movement.metadata,
          idempotencyKey: movement.idempotencyKey,
          createdById: movement.createdById,
        },
        t,
      );
      for (const g of restore) {
        await t.walletBonusGrant.update({
          where: { id: g.id },
          data: { remainingMinor: { increment: BigInt(g.minor) } },
        });
      }
      return result;
    }, tx);
  }

  /** Gives a top-up bonus: PROMOTIONS -> the wallet's bonus, spendable until `expiresAt`. Once per idempotency key. */
  grantBonus(grant: BonusGrant, tx?: Tx): Promise<PostingResult> {
    return this.ledger.run(async (t) => {
      const { wallet, bonus } = await this.ensureWallet(grant.userId, grant.currency, t);
      const promotions = await this.ledger.systemAccount(LedgerAccountType.PROMOTIONS, grant.currency, t);
      const result = await this.ledger.post(
        {
          type: WalletTransactionType.BONUS,
          currency: grant.currency,
          lines: [
            { accountId: promotions.id, direction: DEBIT, amountMinor: grant.amountMinor },
            { accountId: bonus.id, direction: CREDIT, amountMinor: grant.amountMinor },
          ],
          description: 'Top-up bonus',
          metadata: { paymentId: grant.paymentTransactionId, expiresAt: grant.expiresAt.toISOString() },
          idempotencyKey: grant.idempotencyKey,
        },
        t,
      );
      if (!result.replayed) {
        await t.walletBonusGrant.create({
          data: {
            walletId: wallet.id,
            amountMinor: grant.amountMinor,
            remainingMinor: grant.amountMinor,
            expiresAt: grant.expiresAt,
            paymentTransactionId: grant.paymentTransactionId,
            grantTransactionId: result.transaction.id,
          },
        });
      }
      return result;
    }, tx);
  }

  /** Takes back what is left of expired bonuses: wallet bonus -> PROMOTIONS. Safe to run anywhere, any time. */
  async expireBonuses(now = new Date(), batch = 200): Promise<number> {
    const due = await this.prisma.walletBonusGrant.findMany({
      where: { expiresAt: { lte: now }, expiryTransactionId: null },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: batch,
    });
    let expired = 0;
    for (const { id } of due) {
      const taken = await this.ledger.run(async (t) => {
        const [locked] = await t.$queryRaw<{ remaining_minor: bigint; expiry_transaction_id: string | null }[]>`
          SELECT remaining_minor, expiry_transaction_id FROM wallet_bonus_grants WHERE id = ${id}::uuid FOR UPDATE`;
        if (!locked || locked.expiry_transaction_id) return false;
        const grant = await t.walletBonusGrant.findUniqueOrThrow({ where: { id }, include: { wallet: true } });
        if (locked.remaining_minor === 0n) {
          // All spent: nothing to take back. Pointed at its grant journal so it is not looked at again.
          await t.walletBonusGrant.update({ where: { id }, data: { expiryTransactionId: grant.grantTransactionId } });
          return false;
        }
        const { bonus } = await this.ensureWallet(grant.wallet.userId, grant.wallet.currency, t);
        const promotions = await this.ledger.systemAccount(LedgerAccountType.PROMOTIONS, grant.wallet.currency, t);
        const result = await this.ledger.post(
          {
            type: WalletTransactionType.BONUS_EXPIRY,
            currency: grant.wallet.currency,
            lines: [
              { accountId: bonus.id, direction: DEBIT, amountMinor: locked.remaining_minor },
              { accountId: promotions.id, direction: CREDIT, amountMinor: locked.remaining_minor },
            ],
            description: 'Top-up bonus expired',
            metadata: { bonusGrantId: id },
            idempotencyKey: `bonus-expiry:${id}`,
            // Expiry is not spending: it happens to a frozen wallet too.
            allowFrozenDebit: true,
          },
          t,
        );
        await t.walletBonusGrant.update({
          where: { id },
          data: { remainingMinor: 0, expiryTransactionId: result.transaction.id },
        });
        return true;
      });
      if (taken) expired += 1;
    }
    return expired;
  }

  /** An earlier posting with this key, if any: a retried request moves no money twice. */
  private async replayed(tx: Tx, idempotencyKey: string | undefined): Promise<PostingResult | null> {
    if (!idempotencyKey) return null;
    const earlier = await tx.walletTransaction.findUnique({ where: { idempotencyKey }, include: { entries: true } });
    return earlier ? { transaction: earlier, replayed: true } : null;
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
        await this.notifyCredited(tx, userId, result, available.id, currency);
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
    const walletEntry = original.entries.find((e) => e.account.type === LedgerAccountType.USER_WALLET);
    const wallet = walletEntry?.account.wallet;
    if (!walletEntry || !wallet) throw new Error(`Adjustment ${original.reference} has no wallet line`);
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
        // Reversing a debit gives the money back.
        await this.notifyCredited(tx, wallet.userId, result, walletEntry.accountId, currency);
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
      return this.toWalletDto(await this.ensureWallet(userId, currency.code, tx), currency, tx);
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
      const bonus = found.ledgerAccounts.find((a) => a.type === LedgerAccountType.USER_WALLET_BONUS);
      return available && hold && bonus ? { wallet: found, available, hold, bonus } : null;
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
        { code: `WALLET_BONUS:${found.id}`, type: LedgerAccountType.USER_WALLET_BONUS, currency, walletId: found.id },
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
    const currency = await this.currencies.resolve(movement.currency, false, tx);
    return this.ledger.run(async (t) => {
      const { available } = await this.ensureWallet(movement.userId, currency.code, t);
      const other = await this.ledger.systemAccount(counterpart, currency.code, t);
      const result = await this.ledger.post(
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
      if (type === WalletTransactionType.DEPOSIT && !result.replayed) {
        await this.notifyCredited(t, movement.userId, result, available.id, currency);
      }
      return result;
    }, tx);
  }

  /** Tells the user money arrived, if this posting credited the wallet. Refunds are announced by the auction that caused them, not one by one. */
  private notifyCredited(
    tx: Tx,
    userId: string,
    result: PostingResult,
    accountId: string,
    currency: Currency,
  ): Promise<void> {
    const entry = result.transaction.entries.find((e) => e.accountId === accountId);
    if (entry?.direction !== CREDIT) return Promise.resolve();
    const money = (amountMinor: bigint) => ({ amountMinor, currency: currency.code, minorUnits: currency.minorUnits });
    return this.notifications.notify(
      tx,
      userId,
      walletCredited(money(entry.amountMinor), money(entry.balanceAfterMinor), result.transaction.id),
    );
  }

  private resolveCurrency(code?: string, allowInactive = false): Promise<Currency> {
    return this.currencies.resolve(code, allowInactive);
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

  private async toWalletDto(accounts: WalletAccounts, currency: Currency, tx: Tx = this.prisma): Promise<WalletDto> {
    const { wallet, available, hold } = accounts;
    const { bonusMinor, bonusExpiresAt } = await this.spendable(wallet.userId, currency.code, tx);
    const spendableMinor = available.balanceMinor + bonusMinor;
    return {
      id: wallet.id,
      userId: wallet.userId,
      currency: currency.code,
      minorUnits: currency.minorUnits,
      availableMinor: available.balanceMinor.toString(),
      available: formatMinor(available.balanceMinor, currency.minorUnits),
      heldMinor: hold.balanceMinor.toString(),
      held: formatMinor(hold.balanceMinor, currency.minorUnits),
      bonusMinor: bonusMinor.toString(),
      bonus: formatMinor(bonusMinor, currency.minorUnits),
      bonusExpiresAt,
      spendableMinor: spendableMinor.toString(),
      spendable: formatMinor(spendableMinor, currency.minorUnits),
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
      balance: entry.account.type === LedgerAccountType.USER_WALLET_BONUS ? 'BONUS' : 'CASH',
      description: transaction.description,
      reversalOf: transaction.reverses?.reference ?? null,
      createdAt: transaction.createdAt,
    };
  }
}

function withBonusUse(metadata: Prisma.InputJsonValue | undefined, use: BonusUse): Prisma.InputJsonValue {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  return { ...(base as Prisma.InputJsonObject), ...use };
}

/** The bonus a bid fee used, read from its journal. A fee charged before bonuses existed used none. */
function readBonusUse(metadata: Prisma.JsonValue): BonusUse {
  const m = (metadata ?? {}) as Partial<BonusUse>;
  const digits = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
  const grants = Array.isArray(m.bonusGrants) ? m.bonusGrants : [];
  return {
    bonusMinor: digits(m.bonusMinor) ? m.bonusMinor : '0',
    bonusGrants: grants.filter(
      (g): g is { id: string; minor: string } => !!g && typeof g.id === 'string' && digits(g.minor),
    ),
  };
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
