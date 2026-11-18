import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ActorType, PaymentDirection, PaymentStatus, Prisma, RoleName, SecurityEventType } from '@prisma/client';
import type { Currency, PaymentTransaction } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { paging } from '../../common/dto/page-query.dto';
import type { PageQueryDto } from '../../common/dto/page-query.dto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { isStaff } from '../../common/roles';
import { formatMinor } from '../../common/utils/money';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { BiddingService } from '../bidding/bidding.service';
import { CurrencyService } from '../currency/currency.service';
import { LedgerService } from '../ledger/ledger.service';
import type { Tx } from '../ledger/ledger.types';
import { WalletService } from '../wallet/wallet.service';
import { ChapaClient, ChapaError } from './chapa.client';
import { isTestKey, judgeVerification, minorToDecimal, webhookSignatureValid } from './chapa.rules';
import type { ChapaOutcome, ChapaVerification } from './chapa.rules';
import type {
  AdminDepositDto,
  AdminDepositPageDto,
  AdminListDepositsQueryDto,
  DepositDto,
  DepositOptionsDto,
  DepositPageDto,
} from './dto/payment.dto';

export const CHAPA = 'chapa';
/** A user may have this many deposits waiting for payment at once. */
export const MAX_OPEN_DEPOSITS = 5;
/** The provider is not asked about the same payment more often than this, however many requests arrive. */
const MIN_RECHECK_MS = 5_000;
/** A deposit that was recorded but never opened at the provider (a crash in between) is closed after this long. */
const STALE_INITIATED_MS = 10 * 60_000;
const SWEEP_BATCH = 200;
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const OPEN: PaymentStatus[] = [PaymentStatus.INITIATED, PaymentStatus.PENDING];

const depositInclude = { user: { select: { phoneNumber: true } } } satisfies Prisma.PaymentTransactionInclude;
type DepositWithUser = Prisma.PaymentTransactionGetPayload<{ include: typeof depositInclude }>;

interface SettleOptions {
  /** Ask the provider even if it was asked a moment ago. */
  force?: boolean;
  /** Give up on a payment that is still unpaid after the expiry time. */
  expire?: boolean;
}

export interface SweepResult {
  checked: number;
  succeeded: number;
  closed: number;
}

/** Direct charge: the wallet to charge and the number it belongs to, as the payer typed it. */
export interface ChargeRequest {
  method: string;
  phoneNumber?: string;
}

/** Pay and bid: the bids a deposit pays for. */
export interface BidToPay {
  auctionId: string;
  amountsMinor: bigint[];
}

export interface WebhookHeaders {
  'x-chapa-signature'?: unknown;
  'chapa-signature'?: unknown;
}

/**
 * Deposits through Chapa. A wallet is credited in exactly one place, {@link apply}, and only after this server
 * has asked Chapa about the transaction itself and every detail matches what was requested. Webhooks, the
 * payer's return and the background sweep are all just reasons to ask.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    private readonly currencies: CurrencyService,
    private readonly audit: AuditService,
    private readonly chapa: ChapaClient,
    private readonly bidding: BiddingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get enabled(): boolean {
    return this.config.payments.provider === CHAPA;
  }

  /** Phone payments are sent by the payer's browser (Chapa inline), not by this server. */
  private get inline(): boolean {
    const { publicKey, directChargeMethods } = this.config.payments.chapa;
    return this.enabled && publicKey !== '' && directChargeMethods.length > 0;
  }

  private get testMode(): boolean {
    return isTestKey(this.config.payments.chapa.secretKey);
  }

  // ── The signed-in user ─────────────────────────────────────────────────────

  async options(): Promise<DepositOptionsDto> {
    const currency = await this.currencies.resolve();
    const { depositMinMinor, depositMaxMinor } = this.config.payments;
    return {
      enabled: this.enabled,
      provider: this.enabled ? CHAPA : null,
      testMode: this.enabled && this.testMode,
      currency: currency.code,
      minorUnits: currency.minorUnits,
      minAmountMinor: depositMinMinor.toString(),
      maxAmountMinor: depositMaxMinor.toString(),
      bonusPercent: this.config.payments.bonus.percent,
      bonusMaxMinor: this.config.payments.bonus.maxMinor.toString(),
      bonusValidDays: this.config.payments.bonus.validDays,
      directChargeMethods: this.enabled ? this.config.payments.chapa.directChargeMethods : [],
      inlinePublicKey: this.inline ? this.config.payments.chapa.publicKey : null,
    };
  }

  /**
   * Records the deposit, opens it at Chapa and returns where the user pays. No money moves here.
   *
   * With `bid` it is a payment for bids ("pay and bid"): the bids are checked now, so nobody pays for bids that
   * would be refused, the amount must be exactly their fees, and once the payment is confirmed the money goes
   * into the wallet and the bids are placed from it. Should they be refused by then, the money stays in the wallet.
   *
   * With `charge` nobody leaves the site: instead of Chapa's checkout page, the wallet (telebirr, M-Pesa, …) sends
   * the payer a request to approve on their phone. The deposit is confirmed exactly as any other.
   */
  async start(
    user: AuthenticatedUser,
    idempotencyKey: string,
    amountMinor: bigint,
    client: ClientInfo,
    bid?: BidToPay,
    charge?: ChargeRequest,
  ): Promise<{ deposit: DepositDto; replayed: boolean }> {
    this.assertEnabled();
    if (isStaff(user.roles)) {
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'Staff accounts cannot add money');
    }
    const currency = await this.currencies.resolve();

    const earlier = await this.findByKey(user.id, idempotencyKey);
    if (earlier) return this.replay(earlier, amountMinor, currency, bid, charge);

    let mobile: string | null = null;
    if (charge) {
      if (!this.config.payments.chapa.directChargeMethods.includes(charge.method)) {
        throw new AppException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.VALIDATION_FAILED,
          'This way of paying is not offered',
          { directChargeMethods: this.config.payments.chapa.directChargeMethods },
        );
      }
      mobile = walletPhone(charge.phoneNumber ?? user.phoneNumber) ?? null;
      if (!mobile) {
        throw new AppException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.VALIDATION_FAILED,
          'Enter the phone number of the wallet, such as 0911223344',
        );
      }
    }

    const { depositMaxMinor: max } = this.config.payments;
    // Bid fees can be smaller than the smallest deposit; a payment for bids is exactly what the bids cost.
    let min = this.config.payments.depositMinMinor;
    let auctionTitle: string | null = null;
    if (bid) {
      const auction = await this.bidding.check(user, bid.auctionId, bid.amountsMinor);
      const fees = auction.bidFeeMinor * BigInt(bid.amountsMinor.length);
      if (auction.currency !== currency.code || fees !== amountMinor) {
        throw new AppException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.DEPOSIT_AMOUNT_INVALID,
          `These bids cost ${auction.currency} ${formatMinor(fees, currency.minorUnits)}. Please check the amount and try again.`,
          { expectedAmountMinor: fees.toString() },
        );
      }
      min = 1n;
      auctionTitle = auction.title;
    }
    if (amountMinor < min || amountMinor > max) {
      throw new AppException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.DEPOSIT_AMOUNT_INVALID,
        `A deposit must be between ${currency.code} ${formatMinor(min, currency.minorUnits)} and ` +
          `${currency.code} ${formatMinor(max, currency.minorUnits)}`,
        { currency: currency.code, minAmountMinor: min.toString(), maxAmountMinor: max.toString() },
      );
    }

    const { wallet } = await this.wallets.ensureWallet(user.id, currency.code);
    if (wallet.isFrozen) {
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.WALLET_FROZEN, 'This wallet is frozen. Contact support.');
    }
    const open = await this.prisma.paymentTransaction.count({
      where: { userId: user.id, direction: PaymentDirection.DEPOSIT, status: { in: OPEN } },
    });
    if (open >= MAX_OPEN_DEPOSITS) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.DEPOSIT_LIMIT_REACHED,
        `You have ${open} deposits waiting for payment. Finish one of them, or wait for them to expire.`,
      );
    }

    let payment: PaymentTransaction;
    try {
      payment = await this.prisma.paymentTransaction.create({
        data: {
          userId: user.id,
          walletId: wallet.id,
          direction: PaymentDirection.DEPOSIT,
          provider: CHAPA,
          merchantReference: newReference(),
          amountMinor,
          currency: currency.code,
          idempotencyKey,
          chargeMethod: charge?.method,
          // Promised now, at today's terms; given once the payment is confirmed. Bid payments earn none.
          bonusMinor: bid ? 0n : this.bonusFor(amountMinor),
          bidAuctionId: bid?.auctionId,
          bidAmountsMinor: bid?.amountsMinor ?? [],
        },
      });
    } catch (error) {
      // Two requests with the same key at the same moment: the second one answers with the first one's deposit.
      const twin = isUniqueViolation(error) ? await this.findByKey(user.id, idempotencyKey) : null;
      if (!twin) throw error;
      return this.replay(twin, amountMinor, currency, bid, charge);
    }

    const profile = await this.prisma.userProfile.findUnique({ where: { userId: user.id } });
    const [firstName, ...rest] = (profile?.fullName ?? '').trim().split(/\s+/).filter(Boolean);
    const { publicApiUrl, webAppUrl } = this.config.payments;
    let checkoutUrl: string | null = null;
    try {
      if (charge && mobile && this.inline) {
        // The browser sends the request to the phone, with this deposit's reference; nothing to do here.
      } else if (charge && mobile) {
        const { authType } = await this.chapa.directCharge({
          txRef: payment.merchantReference,
          amount: minorToDecimal(amountMinor, currency.minorUnits),
          currency: currency.code,
          mobile,
          type: charge.method,
          firstName,
          lastName: rest.join(' ') || undefined,
          email: profile?.email ?? undefined,
        });
        // A code typed in on the site is not supported: only an approval on the phone completes here.
        if (authType && /otp/i.test(authType)) {
          throw new ChapaError(`Chapa asked for a one-time code (${authType})`, true);
        }
      } else
        ({ checkoutUrl } = await this.chapa.initialize({
          txRef: payment.merchantReference,
          amount: minorToDecimal(amountMinor, currency.minorUnits),
          currency: currency.code,
          phoneNumber: localPhone(user.phoneNumber),
          firstName,
          lastName: rest.join(' ') || undefined,
          email: profile?.email ?? undefined,
          returnUrl: `${webAppUrl}/wallet/deposits/${payment.id}`,
          callbackUrl: publicApiUrl ? `${publicApiUrl}/${this.config.apiPrefix}/payments/chapa/callback` : undefined,
          title: 'LUB Auction',
          // Chapa allows letters, numbers, spaces and a few marks here; an auction title can hold anything.
          description: auctionTitle ? 'Bid fees' : 'Wallet deposit',
        }));
    } catch (error) {
      const reason = error instanceof ChapaError ? error.message : 'The payment could not be opened';
      if (charge && error instanceof ChapaError && error.refused) {
        await this.prisma.paymentTransaction.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.FAILED, failureReason: reason },
        });
        this.logger.warn({ paymentId: payment.id, reason }, 'Chapa did not send a direct charge');
        // Chapa refusing this kind of payment for the account is not the payer's number being wrong.
        const unavailable = /not allowed for direct charge/i.test(reason);
        throw new AppException(
          HttpStatus.BAD_GATEWAY,
          ErrorCode.PAYMENT_PROVIDER_ERROR,
          unavailable
            ? 'Paying from a mobile wallet on this site is not available right now. No money was taken.'
            : 'The payment request could not be sent to that phone. No money was taken.',
          unavailable ? { directCharge: true, unavailable: true } : { directCharge: true },
        );
      }
      await this.prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, failureReason: reason },
      });
      if (!(error instanceof ChapaError)) throw error;
      this.logger.warn({ paymentId: payment.id, status: error.httpStatus, reason }, 'Chapa did not open a deposit');
      throw new AppException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'The payment provider could not start this payment. No money was taken. Please try again.',
      );
    }

    const opened = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentTransaction.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.PENDING, checkoutUrl },
      });
      await this.audit.record(tx, {
        actorId: user.id,
        actorType: ActorType.USER,
        action: 'payment.deposit.start',
        entityType: 'payment_transaction',
        entityId: payment.id,
        after: {
          reference: payment.merchantReference,
          amountMinor: amountMinor.toString(),
          currency: currency.code,
          ...(bid ? { bidAuctionId: bid.auctionId, bidCount: bid.amountsMinor.length } : {}),
          ...(charge ? { chargeMethod: charge.method } : {}),
        },
        client,
      });
      return updated;
    });
    return { deposit: this.toDto(opened, currency), replayed: false };
  }

  async listMine(userId: string, query: PageQueryDto): Promise<DepositPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.PaymentTransactionWhereInput = { userId, direction: PaymentDirection.DEPOSIT };
    const [items, total, currencies] = await Promise.all([
      this.prisma.paymentTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.paymentTransaction.count({ where }),
      this.currencyMap(),
    ]);
    return { items: items.map((p) => this.toDto(p, currencies.get(p.currency))), total, page, limit };
  }

  /** One of my deposits. While it is unpaid this asks the provider again, so the page a payer returns to is current. */
  /**
   * The payer's browser could not send the phone request through Chapa's inline service. The deposit is closed
   * as never sent, after asking Chapa: should Chapa know of a payment after all, it is handled as usual.
   */
  async chargeNotSent(userId: string, id: string, reason: string | undefined): Promise<DepositDto> {
    const found = await this.prisma.paymentTransaction.findFirst({
      where: { id, userId, direction: PaymentDirection.DEPOSIT },
    });
    if (!found) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Deposit not found');
    let current = await this.placePaidBids(await this.settle(found, { force: true }));
    if (current.status === PaymentStatus.PENDING && current.chargeMethod) {
      const said = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'the request was not sent';
      current = await this.prisma.paymentTransaction.update({
        where: { id: current.id },
        data: { status: PaymentStatus.FAILED, failureReason: `${NOT_SENT} (inline): ${said}` },
      });
      this.logger.warn({ paymentId: current.id, reason: said }, 'Chapa inline did not send a phone request');
    }
    return this.toDto(current, await this.currencies.resolve(current.currency, true));
  }

  async getMine(userId: string, id: string): Promise<DepositDto> {
    const found = await this.prisma.paymentTransaction.findFirst({
      where: { id, userId, direction: PaymentDirection.DEPOSIT },
    });
    if (!found) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Deposit not found');
    const current = await this.placePaidBids(await this.settleQuietly(found));
    return this.toDto(current, await this.currencies.resolve(current.currency, true));
  }

  // ── Chapa calling us ───────────────────────────────────────────────────────

  /**
   * A webhook is stored as received and acted on once. It is only ever a hint: what it claims is checked with
   * Chapa before any money moves. Throwing here makes Chapa send the event again later.
   */
  async handleChapaWebhook(rawBody: string | Buffer, headers: WebhookHeaders, body: unknown): Promise<void> {
    if (!this.enabled) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Not found');
    if (!webhookSignatureValid(this.config.payments.chapa.webhookSecret, rawBody, headers)) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
        'The webhook signature is missing or wrong',
      );
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'The webhook body must be an object');
    }
    const fields = body as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    const event = text(fields.event) ?? 'unknown';
    const txRef = text(fields.tx_ref);
    // Chapa sends no event id, so one is built from what makes an event distinct: its kind and the payment it is about.
    const subject = text(fields.reference) ?? txRef ?? createHash('sha256').update(rawBody).digest('hex');
    const providerEventId = `${event}:${subject}`.slice(0, 128);

    const payment = txRef
      ? await this.prisma.paymentTransaction.findUnique({ where: { merchantReference: txRef.slice(0, 64) } })
      : null;
    const deposit = payment?.provider === CHAPA && payment.direction === PaymentDirection.DEPOSIT ? payment : null;
    const key = { provider_providerEventId: { provider: CHAPA, providerEventId } };
    await this.prisma.paymentProviderEvent.createMany({
      data: [
        {
          provider: CHAPA,
          providerEventId,
          paymentTransactionId: deposit?.id,
          signatureValid: true,
          payload: fields as Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
    const stored = await this.prisma.paymentProviderEvent.findUniqueOrThrow({ where: key });
    if (stored.processedAt) return;

    let note: string | null = null;
    try {
      if (!deposit) note = 'No deposit has this tx_ref';
      else if (/refund|revers/i.test(event)) await this.flagForReview(deposit.id, `Chapa reported ${event}`, fields);
      else await this.settle(deposit, { force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Processing failed';
      await this.prisma.paymentProviderEvent.update({ where: key, data: { processingError: message.slice(0, 500) } });
      if (error instanceof ChapaError) {
        throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_BUSY, 'Try again later');
      }
      throw error;
    }
    await this.prisma.paymentProviderEvent.update({
      where: key,
      data: { processedAt: new Date(), processingError: note },
    });
  }

  /** Chapa's browser-side callback. Anyone can call it, so it carries no authority: it only triggers a check. */
  async handleChapaCallback(txRef: unknown): Promise<void> {
    if (!this.enabled || typeof txRef !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(txRef)) return;
    const payment = await this.prisma.paymentTransaction.findUnique({ where: { merchantReference: txRef } });
    if (payment) await this.settleQuietly(payment);
  }

  // ── Background ─────────────────────────────────────────────────────────────

  /** Asks Chapa about deposits still waiting, less often the older they get, and gives up on the ones never paid. */
  async sweep(now = new Date()): Promise<SweepResult> {
    const result: SweepResult = { checked: 0, succeeded: 0, closed: 0 };
    // Bonuses expire whether or not a payment provider is configured right now.
    await this.wallets.expireBonuses(now);
    if (!this.enabled) return result;
    const stale = await this.prisma.paymentTransaction.updateMany({
      where: {
        provider: CHAPA,
        direction: PaymentDirection.DEPOSIT,
        status: PaymentStatus.INITIATED,
        createdAt: { lt: new Date(now.getTime() - STALE_INITIATED_MS) },
      },
      data: { status: PaymentStatus.FAILED, failureReason: 'The payment was never opened at the provider' },
    });
    result.closed += stale.count;

    const waiting = await this.prisma.paymentTransaction.findMany({
      where: { provider: CHAPA, direction: PaymentDirection.DEPOSIT, status: PaymentStatus.PENDING },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: SWEEP_BATCH,
    });
    // Paid, but the bids were not placed yet (the server stopped in between): place them now.
    const paid = await this.prisma.paymentTransaction.findMany({
      where: {
        direction: PaymentDirection.DEPOSIT,
        status: PaymentStatus.SUCCEEDED,
        bidAuctionId: { not: null },
        bidSubmissionId: null,
        bidError: null,
      },
      take: SWEEP_BATCH,
    });
    for (const payment of paid) await this.placePaidBids(payment);

    for (const payment of waiting) {
      if (!isDue(payment, now)) continue;
      try {
        const after = await this.settle(payment, { force: true, expire: true });
        result.checked += 1;
        if (after.status === PaymentStatus.SUCCEEDED) result.succeeded += 1;
        else if (after.status !== PaymentStatus.PENDING) result.closed += 1;
      } catch (error) {
        // Chapa is unreachable or refusing: the rest would fail the same way, so they wait for the next run.
        this.logger.warn({ err: error, paymentId: payment.id }, 'Deposit sweep stopped: Chapa could not be asked');
        break;
      }
    }
    return result;
  }

  // ── Back office ────────────────────────────────────────────────────────────

  async list(query: AdminListDepositsQueryDto): Promise<AdminDepositPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.PaymentTransactionWhereInput = {
      direction: PaymentDirection.DEPOSIT,
      status: query.status,
      userId: query.userId,
      ...(query.needsReview === undefined ? {} : { reviewReason: query.needsReview ? { not: null } : null }),
      ...(query.reference
        ? { OR: [{ merchantReference: query.reference }, { providerReference: query.reference }] }
        : {}),
    };
    const [items, total, currencies] = await Promise.all([
      this.prisma.paymentTransaction.findMany({
        where,
        include: depositInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.paymentTransaction.count({ where }),
      this.currencyMap(),
    ]);
    return { items: items.map((p) => this.toAdminDto(p, currencies.get(p.currency))), total, page, limit };
  }

  async getForAdmin(id: string): Promise<AdminDepositDto> {
    const found = await this.findDeposit(id);
    return this.toAdminDto(found, await this.currencies.resolve(found.currency, true));
  }

  /** Staff ask Chapa about one deposit now. The same rules apply as everywhere else; staff cannot credit by hand here. */
  async recheck(actorId: string, id: string, client: ClientInfo): Promise<AdminDepositDto> {
    this.assertEnabled();
    const before = await this.findDeposit(id);
    try {
      await this.settle(before, { force: true });
    } catch (error) {
      if (!(error instanceof ChapaError)) throw error;
      throw new AppException(HttpStatus.BAD_GATEWAY, ErrorCode.PAYMENT_PROVIDER_ERROR, error.message);
    }
    const after = await this.findDeposit(id);
    await this.audit.record(this.prisma, {
      actorId,
      actorType: ActorType.ADMIN,
      action: 'payment.deposit.recheck',
      entityType: 'payment_transaction',
      entityId: id,
      before: { status: before.status },
      after: { status: after.status },
      client,
    });
    return this.toAdminDto(after, await this.currencies.resolve(after.currency, true));
  }

  /** Staff record that a flagged deposit has been dealt with. Any correction to the wallet is a separate adjustment. */
  resolveReview(actorId: string, id: string, note: string, client: ClientInfo): Promise<AdminDepositDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_transactions WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.paymentTransaction.findFirst({ where: { id, direction: PaymentDirection.DEPOSIT } });
      if (!before) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Deposit not found');
      if (!before.reviewReason) {
        throw new AppException(HttpStatus.CONFLICT, ErrorCode.CONFLICT, 'This deposit is not waiting for review');
      }
      const after = await tx.paymentTransaction.update({
        where: { id },
        data: { reviewReason: null },
        include: depositInclude,
      });
      await this.audit.record(tx, {
        actorId,
        actorType: ActorType.ADMIN,
        action: 'payment.deposit.review-resolved',
        entityType: 'payment_transaction',
        entityId: id,
        before: { reviewReason: before.reviewReason },
        metadata: { note },
        client,
      });
      return this.toAdminDto(after, await this.currencies.resolve(after.currency, true, tx));
    });
  }

  // ── Confirming a payment ───────────────────────────────────────────────────

  /** Asks Chapa about a deposit and records what it says. Throws ChapaError when Chapa cannot be asked. */
  private async settle(payment: PaymentTransaction, options: SettleOptions = {}): Promise<PaymentTransaction> {
    if (payment.provider !== CHAPA || payment.direction !== PaymentDirection.DEPOSIT) return payment;
    if (payment.status === PaymentStatus.SUCCEEDED || payment.status === PaymentStatus.INITIATED) return payment;
    // A closed deposit is only looked at again when something new arrives: a webhook, or staff asking.
    if (!options.force && payment.status !== PaymentStatus.PENDING) return payment;
    const sinceLast = payment.lastCheckedAt ? Date.now() - payment.lastCheckedAt.getTime() : Infinity;
    if (!options.force && sinceLast < MIN_RECHECK_MS) return payment;

    const currency = await this.currencies.resolve(payment.currency, true);
    let answer: ChapaVerification | null;
    try {
      answer = await this.chapa.verify(payment.merchantReference);
    } catch (error) {
      if (error instanceof ChapaError && error.modeMismatch) return this.closeOtherMode(payment, error.message);
      throw error;
    }
    const outcome = judgeVerification(answer, {
      txRef: payment.merchantReference,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      minorUnits: currency.minorUnits,
      testMode: this.testMode,
    });
    const after = await this.ledger.run((tx) => this.apply(tx, payment.id, outcome, answer, options));
    return this.placePaidBids(after);
  }

  /**
   * Pay and bid, second half: the payment is in the wallet, so the bids are placed from it. Placing is idempotent
   * (keyed on the payment), so the webhook, the return page and the sweep can all try. A refusal is final and
   * kept; the money then stays in the wallet. Any other failure is left for the next try.
   */
  private async placePaidBids(payment: PaymentTransaction): Promise<PaymentTransaction> {
    if (
      payment.status !== PaymentStatus.SUCCEEDED ||
      !payment.bidAuctionId ||
      payment.bidSubmissionId ||
      payment.bidError
    ) {
      return payment;
    }
    const bidder: AuthenticatedUser = {
      id: payment.userId,
      phoneNumber: '',
      roles: [RoleName.USER],
      sessionId: '',
      mustChangePassword: false,
    };
    try {
      const { submission } = await this.bidding.place(
        bidder,
        payment.bidAuctionId,
        payment.bidAmountsMinor.map(String),
        `pay:${payment.id}`,
        {},
      );
      await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, bidSubmissionId: null },
        data: { bidSubmissionId: submission.id },
      });
    } catch (error) {
      if (!(error instanceof AppException)) {
        this.logger.warn({ err: error, paymentId: payment.id }, 'Paid bids could not be placed yet');
        return payment;
      }
      await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, bidSubmissionId: null, bidError: null },
        data: { bidError: error.message.slice(0, 500) },
      });
    }
    return this.prisma.paymentTransaction.findUniqueOrThrow({ where: { id: payment.id } });
  }

  /** As {@link settle}, for callers that show the deposit either way: a failed check leaves it as it was. */
  private async settleQuietly(payment: PaymentTransaction): Promise<PaymentTransaction> {
    if (!this.enabled) return payment;
    try {
      return await this.settle(payment);
    } catch (error) {
      this.logger.warn({ err: error, paymentId: payment.id }, 'A deposit could not be checked with Chapa');
      return payment;
    }
  }

  /**
   * The only place a deposit changes state after it was opened. The row lock makes concurrent confirmations
   * (webhook, return page and sweep at once) queue up; whoever comes second finds it already done.
   */
  private async apply(
    tx: Tx,
    id: string,
    outcome: ChapaOutcome,
    answer: ChapaVerification | null,
    options: SettleOptions,
  ): Promise<PaymentTransaction> {
    await tx.$queryRaw`SELECT id FROM payment_transactions WHERE id = ${id}::uuid FOR UPDATE`;
    const payment = await tx.paymentTransaction.findUniqueOrThrow({ where: { id } });
    if (payment.status === PaymentStatus.SUCCEEDED) return payment;
    const now = new Date();
    const stillOpen = OPEN.includes(payment.status);
    const payload = (answer ?? undefined) as Prisma.InputJsonObject | undefined;

    if (outcome.state === 'paid') {
      const taken = outcome.reference
        ? await tx.paymentTransaction.findFirst({
            where: { provider: CHAPA, providerReference: outcome.reference, id: { not: id } },
            select: { merchantReference: true },
          })
        : null;
      if (taken) {
        outcome = {
          state: 'mismatch',
          reason: `Chapa reference ${outcome.reference} already belongs to ${taken.merchantReference}`,
        };
      } else {
        const posted = await this.wallets.deposit(
          {
            userId: payment.userId,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            idempotencyKey: `payment:${CHAPA}:${payment.merchantReference}`,
            description: 'Deposit through Chapa',
            metadata: { paymentId: payment.id, reference: payment.merchantReference },
          },
          tx,
        );
        if (payment.bonusMinor > 0n) {
          await this.wallets.grantBonus(
            {
              userId: payment.userId,
              currency: payment.currency,
              amountMinor: payment.bonusMinor,
              expiresAt: new Date(now.getTime() + this.config.payments.bonus.validDays * 86_400_000),
              paymentTransactionId: payment.id,
              idempotencyKey: `bonus:payment:${payment.merchantReference}`,
            },
            tx,
          );
        }
        const updated = await tx.paymentTransaction.update({
          where: { id },
          data: {
            status: PaymentStatus.SUCCEEDED,
            providerReference: outcome.reference,
            walletTransactionId: posted.transaction.id,
            verifiedAt: now,
            lastCheckedAt: now,
            failureReason: null,
            providerPayload: payload,
          },
        });
        await this.audit.record(tx, {
          actorType: ActorType.SYSTEM,
          action: 'payment.deposit.succeeded',
          entityType: 'payment_transaction',
          entityId: id,
          before: { status: payment.status },
          after: {
            status: updated.status,
            amountMinor: payment.amountMinor.toString(),
            currency: payment.currency,
            walletTransactionId: posted.transaction.id,
            providerReference: outcome.reference,
          },
        });
        return updated;
      }
    }

    if (outcome.state === 'mismatch') {
      await tx.securityEvent.create({
        data: {
          type: SecurityEventType.SUSPICIOUS_PAYMENT,
          userId: payment.userId,
          metadata: { paymentId: id, reference: payment.merchantReference, reason: outcome.reason },
        },
      });
      return tx.paymentTransaction.update({
        where: { id },
        data: {
          status: stillOpen ? PaymentStatus.FAILED : payment.status,
          failureReason: stillOpen ? 'The payment did not match what was requested' : payment.failureReason,
          reviewReason: outcome.reason,
          lastCheckedAt: now,
          providerPayload: payload,
        },
      });
    }

    if (outcome.state === 'failed' && stillOpen) {
      return tx.paymentTransaction.update({
        where: { id },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: outcome.reason,
          lastCheckedAt: now,
          providerPayload: payload,
        },
      });
    }

    const expiresAt = payment.createdAt.getTime() + this.config.payments.depositExpiryMinutes * 60_000;
    if (outcome.state === 'pending' && options.expire && stillOpen && expiresAt <= now.getTime()) {
      return tx.paymentTransaction.update({
        where: { id },
        data: {
          status: PaymentStatus.EXPIRED,
          failureReason: 'The payment was not completed in time',
          lastCheckedAt: now,
        },
      });
    }
    return tx.paymentTransaction.update({ where: { id }, data: { lastCheckedAt: now } });
  }

  /**
   * The payment was opened with a Chapa key of the other mode (test or live) than the one in use now, so this key can
   * never confirm it. It is closed (it would otherwise hold up every other check) and flagged for finance staff: if it
   * was a real payment, they switch the key back and ask Chapa again, which credits the wallet as usual.
   */
  private async closeOtherMode(payment: PaymentTransaction, reason: string): Promise<PaymentTransaction> {
    this.logger.warn({ paymentId: payment.id }, 'Deposit opened with the other Chapa key mode: closed for review');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_transactions WHERE id = ${payment.id}::uuid FOR UPDATE`;
      const current = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: payment.id } });
      if (current.status === PaymentStatus.SUCCEEDED) return current;
      const open = OPEN.includes(current.status);
      return tx.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          status: open ? PaymentStatus.FAILED : current.status,
          failureReason: open ? 'Opened with a Chapa key of the other mode (test or live)' : current.failureReason,
          reviewReason:
            current.reviewReason ??
            `${reason}. Opened with the other Chapa key mode: check it in Chapa's dashboard, or switch the key back and ask Chapa again.`,
          lastCheckedAt: new Date(),
        },
      });
    });
  }

  /** A refund or reversal reported by Chapa. Nothing is taken from the wallet: finance staff decide what to do. */
  private async flagForReview(id: string, reason: string, payload: Record<string, unknown>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.paymentTransaction.update({ where: { id }, data: { reviewReason: reason } });
      await tx.securityEvent.create({
        data: {
          type: SecurityEventType.SUSPICIOUS_PAYMENT,
          userId: payment.userId,
          metadata: { paymentId: id, reference: payment.merchantReference, reason },
        },
      });
      await this.audit.record(tx, {
        actorType: ActorType.SYSTEM,
        action: 'payment.deposit.flagged',
        entityType: 'payment_transaction',
        entityId: id,
        metadata: { reason, status: payment.status, event: payload as Prisma.InputJsonObject },
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** The top-up bonus a wallet top-up of this amount earns under the current terms. */
  private bonusFor(amountMinor: bigint): bigint {
    const { percent, maxMinor } = this.config.payments.bonus;
    const bonus = (amountMinor * BigInt(percent)) / 100n;
    return bonus < maxMinor ? bonus : maxMinor;
  }

  private assertEnabled(): void {
    if (this.enabled) return;
    throw new AppException(
      HttpStatus.SERVICE_UNAVAILABLE,
      ErrorCode.PAYMENTS_UNAVAILABLE,
      'Adding money online is not available at the moment',
    );
  }

  private findByKey(userId: string, idempotencyKey: string): Promise<PaymentTransaction | null> {
    return this.prisma.paymentTransaction.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
  }

  private replay(
    earlier: PaymentTransaction,
    amountMinor: bigint,
    currency: Currency,
    bid?: BidToPay,
    charge?: ChargeRequest,
  ): { deposit: DepositDto; replayed: boolean } {
    const sameBid =
      (earlier.bidAuctionId ?? undefined) === bid?.auctionId &&
      earlier.bidAmountsMinor.length === (bid?.amountsMinor.length ?? 0) &&
      earlier.bidAmountsMinor.every((amount, i) => amount === bid?.amountsMinor[i]);
    const sameCharge = (earlier.chargeMethod ?? undefined) === charge?.method;
    if (
      earlier.direction !== PaymentDirection.DEPOSIT ||
      earlier.amountMinor !== amountMinor ||
      !sameBid ||
      !sameCharge
    ) {
      throw new AppException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used for a different request',
      );
    }
    return { deposit: this.toDto(earlier, currency), replayed: true };
  }

  private async findDeposit(id: string): Promise<DepositWithUser> {
    const found = await this.prisma.paymentTransaction.findFirst({
      where: { id, direction: PaymentDirection.DEPOSIT },
      include: depositInclude,
    });
    if (!found) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Deposit not found');
    return found;
  }

  private async currencyMap(): Promise<Map<string, Currency>> {
    const all = await this.prisma.currency.findMany();
    return new Map(all.map((c) => [c.code, c]));
  }

  private toDto(payment: PaymentTransaction, currency?: Currency): DepositDto {
    const minorUnits = currency?.minorUnits ?? 2;
    return {
      id: payment.id,
      status: payment.status,
      provider: payment.provider,
      reference: payment.merchantReference,
      amountMinor: payment.amountMinor.toString(),
      amount: formatMinor(payment.amountMinor, minorUnits),
      currency: payment.currency,
      minorUnits,
      checkoutUrl: payment.status === PaymentStatus.PENDING ? payment.checkoutUrl : null,
      chargeMethod: payment.chargeMethod,
      bonusMinor: payment.bonusMinor.toString(),
      bonus: formatMinor(payment.bonusMinor, minorUnits),
      failureReason: publicFailureReason(payment.status),
      requestNotSent: payment.status === PaymentStatus.FAILED && !!payment.failureReason?.startsWith(NOT_SENT),
      walletTransactionId: payment.walletTransactionId,
      confirmedAt: payment.verifiedAt,
      expiresAt: new Date(payment.createdAt.getTime() + this.config.payments.depositExpiryMinutes * 60_000),
      createdAt: payment.createdAt,
      bid: payment.bidAuctionId
        ? {
            auctionId: payment.bidAuctionId,
            amountsMinor: payment.bidAmountsMinor.map(String),
            amounts: payment.bidAmountsMinor.map((amount) => formatMinor(amount, minorUnits)),
            state: payment.bidSubmissionId ? 'PLACED' : payment.bidError ? 'REFUSED' : 'WAITING',
            submissionId: payment.bidSubmissionId,
            error: payment.bidError,
          }
        : null,
    };
  }

  private toAdminDto(payment: DepositWithUser, currency?: Currency): AdminDepositDto {
    return {
      ...this.toDto(payment, currency),
      failureReason: payment.failureReason,
      userId: payment.userId,
      phoneNumber: payment.user.phoneNumber,
      providerReference: payment.providerReference,
      reviewReason: payment.reviewReason,
      lastCheckedAt: payment.lastCheckedAt,
      updatedAt: payment.updatedAt,
    };
  }
}

/** What the payer is told. The provider's own wording stays in the back office. */
/** How a direct charge Chapa refused to send is recorded (see ChapaClient.directCharge). */
const NOT_SENT = 'Chapa did not send the payment request';

function publicFailureReason(status: PaymentStatus): string | null {
  if (status === PaymentStatus.EXPIRED) return 'The payment was not completed in time. No money was added.';
  if (status === PaymentStatus.FAILED || status === PaymentStatus.CANCELLED) {
    return 'The payment was not completed. No money was added.';
  }
  return null;
}

/** Sweep spacing: a fresh deposit is checked every 30 seconds, an old one at most every 10 minutes. */
export function isDue(payment: Pick<PaymentTransaction, 'createdAt' | 'lastCheckedAt'>, now: Date): boolean {
  if (!payment.lastCheckedAt) return true;
  const age = now.getTime() - payment.createdAt.getTime();
  const gap = Math.min(Math.max(age / 10, 30_000), 600_000);
  return now.getTime() - payment.lastCheckedAt.getTime() >= gap;
}

/** A wallet number as typed (0911…, 911…, +251911…, 251911…), in the 09/07 form Chapa wants; null if it is not one. */
export function walletPhone(input: string): string | undefined {
  const digits = input.replace(/[\s-]/g, '');
  const match = /^(?:\+?251|0)?([79]\d{8})$/.exec(digits);
  return match ? `0${match[1]}` : undefined;
}

/** Chapa accepts Ethiopian mobile numbers as 09xxxxxxxx or 07xxxxxxxx only; anything else is left out. */
export function localPhone(e164: string): string | undefined {
  const match = /^\+251([79]\d{8})$/.exec(e164);
  return match ? `0${match[1]}` : undefined;
}

function newReference(): string {
  const bytes = randomBytes(20);
  let out = 'LUB-';
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
