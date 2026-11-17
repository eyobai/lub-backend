import { HttpStatus, Injectable } from '@nestjs/common';
import { ActorType, PrizeDeliveryStatus, WinnerVerificationStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { paging } from '../../common/dto/page-query.dto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { formatMinor } from '../../common/utils/money';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { deliveryUpdated, winRejected, winVerified } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
import { ResultsService } from '../results/results.service';
import { allowedNextStatuses, canMove, noteRequired, recipientRequired, winnerCanEditDetails } from './delivery-rules';
import type {
  AdminListWinnersQueryDto,
  AdminWinnerDto,
  AdminWinnerPageDto,
  DeliveryAddressDto,
  DeliveryDto,
  MyWinDto,
  MyWinPageDto,
  PublicWinnerDetailDto,
  PublicWinnerPageDto,
  SetDeliveryStatusDto,
  SubmitDeliveryDetailsDto,
  UpdateDeliveryDto,
} from './dto/winner.dto';
import type { PageQueryDto } from '../../common/dto/page-query.dto';

type Tx = Prisma.TransactionClient;
interface Actor {
  id: string;
  client: ClientInfo;
}

const winnerInclude = {
  auction: {
    select: {
      title: true,
      product: { select: { name: true, images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } } } },
    },
  },
  user: { select: { phoneNumber: true, profile: { select: { fullName: true } } } },
  currencyRef: { select: { minorUnits: true } },
  delivery: { include: { events: { orderBy: { createdAt: 'asc' } } } },
} satisfies Prisma.WinnerInclude;
type WinnerWithRelations = Prisma.WinnerGetPayload<{ include: typeof winnerInclude }>;

const notFound = () => new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Winner not found');
const auctionOf = (w: WinnerWithRelations) => ({ id: w.auctionId, title: w.auction.title });

/** "+251911234567" → "+2519*****67": enough to recognize your own number, not enough to contact someone. */
export const maskPhone = (phone: string): string =>
  phone.length < 9 ? '*'.repeat(phone.length) : `${phone.slice(0, 5)}${'*'.repeat(phone.length - 7)}${phone.slice(-2)}`;

const base = (w: WinnerWithRelations) => ({
  id: w.id,
  auctionId: w.auctionId,
  auctionTitle: w.auction.title,
  productName: w.auction.product.name,
  productImageUrl: w.auction.product.images[0]?.url ?? null,
  amountMinor: w.amountMinor.toString(),
  amount: formatMinor(w.amountMinor, w.currencyRef.minorUnits),
  currency: w.currency,
});

const toDeliveryDto = (d: NonNullable<WinnerWithRelations['delivery']>): DeliveryDto => ({
  status: d.status,
  recipientName: d.recipientName,
  recipientPhone: d.recipientPhone,
  address: d.address as DeliveryAddressDto | null,
  trackingInfo: d.trackingInfo,
  updatedAt: d.updatedAt,
});

const toMyWinDto = (w: WinnerWithRelations): MyWinDto => ({
  ...base(w),
  verificationStatus: w.verificationStatus,
  publishedAt: w.publishedAt,
  canEditDeliveryDetails: w.delivery !== null && winnerCanEditDetails(w.delivery.status),
  delivery: w.delivery && toDeliveryDto(w.delivery),
  createdAt: w.createdAt,
});

const toAdminDto = (w: WinnerWithRelations): AdminWinnerDto => ({
  ...base(w),
  userId: w.userId,
  phoneNumber: w.user.phoneNumber,
  fullName: w.user.profile?.fullName ?? null,
  bidId: w.bidId,
  verificationStatus: w.verificationStatus,
  verificationNote: w.verificationNote,
  verifiedById: w.verifiedById,
  verifiedAt: w.verifiedAt,
  publishedAt: w.publishedAt,
  delivery: w.delivery && {
    ...toDeliveryDto(w.delivery),
    id: w.delivery.id,
    notes: w.delivery.notes,
    allowedNextStatuses: allowedNextStatuses(w.delivery.status),
    events: w.delivery.events.map((e) => ({
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      actorId: e.actorId,
      createdAt: e.createdAt,
    })),
  },
  createdAt: w.createdAt,
});

/** The parts of a winner worth comparing in an audit record. */
const snapshot = (w: WinnerWithRelations): Prisma.InputJsonObject => ({
  verificationStatus: w.verificationStatus,
  verificationNote: w.verificationNote,
  publishedAt: w.publishedAt?.toISOString() ?? null,
  delivery: w.delivery && {
    status: w.delivery.status,
    recipientName: w.delivery.recipientName,
    recipientPhone: w.delivery.recipientPhone,
    address: w.delivery.address,
    trackingInfo: w.delivery.trackingInfo,
    notes: w.delivery.notes,
  },
});

@Injectable()
export class WinnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly results: ResultsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Public and winner-facing ───────────────────────────────────────────────

  /** Recent winners: only those an admin has verified and published. */
  async listPublished(query: PageQueryDto): Promise<PublicWinnerPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.WinnerWhereInput = {
      publishedAt: { not: null },
      verificationStatus: WinnerVerificationStatus.VERIFIED,
    };
    const [items, total] = await Promise.all([
      this.prisma.winner.findMany({
        where,
        include: winnerInclude,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.winner.count({ where }),
    ]);
    return {
      items: items.map((w) => ({
        ...base(w),
        winnerLabel: maskPhone(w.user.phoneNumber),
        publishedAt: w.publishedAt as Date,
      })),
      total,
      page,
      limit,
    };
  }

  /** One published winner with how many bids each amount got: the whole draw, without who placed the bids. */
  async getPublished(id: string): Promise<PublicWinnerDetailDto> {
    const w = await this.prisma.winner.findFirst({
      where: { id, publishedAt: { not: null }, verificationStatus: WinnerVerificationStatus.VERIFIED },
      include: {
        ...winnerInclude,
        auction: { select: { ...winnerInclude.auction.select, bidFeeMinor: true, result: true } },
      },
    });
    const result = w?.auction.result;
    if (!w || !result) throw notFound();
    const minorUnits = w.currencyRef.minorUnits;
    return {
      ...base(w),
      winnerLabel: maskPhone(w.user.phoneNumber),
      publishedAt: w.publishedAt as Date,
      bidFeeMinor: w.auction.bidFeeMinor.toString(),
      bidFee: formatMinor(w.auction.bidFeeMinor, minorUnits),
      totalBids: result.totalBids,
      distinctAmounts: result.distinctAmounts,
      uniqueAmounts: result.uniqueAmounts,
      histogram: (result.histogram as unknown as { amountMinor: string; count: number }[]).map((entry) => ({
        amountMinor: entry.amountMinor,
        amount: formatMinor(BigInt(entry.amountMinor), minorUnits),
        count: entry.count,
      })),
    };
  }

  async listMine(userId: string, query: PageQueryDto): Promise<MyWinPageDto> {
    const { page, limit, skip } = paging(query);
    const [items, total] = await Promise.all([
      this.prisma.winner.findMany({
        where: { userId },
        include: winnerInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.winner.count({ where: { userId } }),
    ]);
    return { items: items.map(toMyWinDto), total, page, limit };
  }

  /** The winner tells us who receives the prize and where, until staff have confirmed the details. */
  submitMyDeliveryDetails(
    userId: string,
    winnerId: string,
    dto: SubmitDeliveryDetailsDto,
    client: ClientInfo,
  ): Promise<MyWinDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, winnerId);
      if (before.userId !== userId) throw notFound(); // someone else's win looks like no win at all
      if (!before.delivery) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.WINNER_INVALID_STATE,
          'Delivery details can be sent once this win has been verified',
          { verificationStatus: before.verificationStatus },
        );
      }
      if (!winnerCanEditDetails(before.delivery.status)) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.DELIVERY_INVALID_STATE,
          'The delivery details have been confirmed and can no longer be changed here; contact support',
          { status: before.delivery.status },
        );
      }
      await tx.prizeDelivery.update({
        where: { id: before.delivery.id },
        data: { recipientName: dto.recipientName, recipientPhone: dto.recipientPhone, address: { ...dto.address } },
      });
      const after = await this.record(tx, before, 'delivery.details-submitted', { id: userId, client }, ActorType.USER);
      return toMyWinDto(after);
    });
  }

  // ── Back office ────────────────────────────────────────────────────────────

  async list(query: AdminListWinnersQueryDto): Promise<AdminWinnerPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.WinnerWhereInput = {
      verificationStatus: query.verificationStatus,
      userId: query.userId,
      delivery: query.deliveryStatus ? { status: query.deliveryStatus } : undefined,
      publishedAt: query.published === undefined ? undefined : query.published ? { not: null } : null,
    };
    const [items, total] = await Promise.all([
      this.prisma.winner.findMany({
        where,
        include: winnerInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.winner.count({ where }),
    ]);
    return { items: items.map(toAdminDto), total, page, limit };
  }

  async get(id: string): Promise<AdminWinnerDto> {
    const winner = await this.prisma.winner.findUnique({ where: { id }, include: winnerInclude });
    if (!winner) throw notFound();
    return toAdminDto(winner);
  }

  /**
   * Confirms the winner. The result is first recomputed from the bids on record; a winner is verified only
   * if that still names the same bid. Verification opens the prize delivery.
   */
  verify(actor: Actor, id: string, note: string | undefined): Promise<AdminWinnerDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      this.assertVerification(
        before,
        [WinnerVerificationStatus.PENDING_VERIFICATION, WinnerVerificationStatus.REJECTED],
        'verified',
      );
      if (before.userId === actor.id) {
        throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, 'You cannot verify your own win');
      }
      const check = await this.results.auditResult(before.auctionId, tx);
      if (!check.matches || check.recomputed.winningBidId !== before.bidId) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.RESULT_MISMATCH,
          'The recorded result does not match the bids on record; this winner cannot be verified',
          { recorded: { ...check.recorded }, recomputed: { ...check.recomputed } },
        );
      }
      await tx.winner.update({
        where: { id },
        data: {
          verificationStatus: WinnerVerificationStatus.VERIFIED,
          verificationNote: note || null,
          verifiedById: actor.id,
          verifiedAt: new Date(),
        },
      });
      if (!before.delivery) {
        await tx.prizeDelivery.create({
          data: {
            winnerId: id,
            events: { create: { toStatus: PrizeDeliveryStatus.PENDING, note: 'Winner verified', actorId: actor.id } },
          },
        });
      }
      await this.notifications.notify(tx, before.userId, winVerified(auctionOf(before), id));
      return toAdminDto(await this.record(tx, before, 'winner.verify', actor));
    });
  }

  /** Marks the winner as not confirmed. Nothing else changes: the result stays on record and no other winner is picked. */
  reject(actor: Actor, id: string, reason: string): Promise<AdminWinnerDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      this.assertVerification(before, [WinnerVerificationStatus.PENDING_VERIFICATION], 'rejected');
      await tx.winner.update({
        where: { id },
        data: {
          verificationStatus: WinnerVerificationStatus.REJECTED,
          verificationNote: reason,
          verifiedById: actor.id,
          verifiedAt: new Date(),
        },
      });
      // The reason is an internal note; the winner is told only that the win was not confirmed.
      await this.notifications.notify(tx, before.userId, winRejected(auctionOf(before), id));
      return toAdminDto(await this.record(tx, before, 'winner.reject', actor, ActorType.ADMIN, { reason }));
    });
  }

  /** Shows a verified winner in the public recent-winners list. */
  publish(actor: Actor, id: string): Promise<AdminWinnerDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      this.assertVerification(before, [WinnerVerificationStatus.VERIFIED], 'published');
      if (before.publishedAt) return toAdminDto(before);
      await tx.winner.update({ where: { id }, data: { publishedAt: new Date() } });
      return toAdminDto(await this.record(tx, before, 'winner.publish', actor));
    });
  }

  unpublish(actor: Actor, id: string): Promise<AdminWinnerDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (!before.publishedAt) return toAdminDto(before);
      await tx.winner.update({ where: { id }, data: { publishedAt: null } });
      return toAdminDto(await this.record(tx, before, 'winner.unpublish', actor));
    });
  }

  updateDelivery(actor: Actor, id: string, dto: UpdateDeliveryDto): Promise<AdminWinnerDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      const delivery = this.deliveryOf(before);
      await tx.prizeDelivery.update({
        where: { id: delivery.id },
        data: {
          recipientName: dto.recipientName,
          recipientPhone: dto.recipientPhone,
          address: dto.address && { ...dto.address },
          trackingInfo: dto.trackingInfo === '' ? null : dto.trackingInfo,
          notes: dto.notes === '' ? null : dto.notes,
        },
      });
      return toAdminDto(await this.record(tx, before, 'delivery.update', actor));
    });
  }

  setDeliveryStatus(actor: Actor, id: string, dto: SetDeliveryStatusDto): Promise<AdminWinnerDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      const delivery = this.deliveryOf(before);
      const from = delivery.status;
      if (!canMove(from, dto.status)) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.DELIVERY_INVALID_STATE,
          `A delivery that is ${from} cannot be moved to ${dto.status}`,
          { status: from, allowedNextStatuses: allowedNextStatuses(from) },
        );
      }
      const missing = [
        ...(noteRequired(from, dto.status) && !dto.note ? ['note'] : []),
        ...(recipientRequired(dto.status)
          ? (['recipientName', 'recipientPhone', 'address'] as const).filter((field) => !delivery[field])
          : []),
      ];
      if (missing.length > 0) {
        throw new AppException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ErrorCode.DELIVERY_DETAILS_REQUIRED,
          `Provide ${missing.join(', ')} before moving this delivery to ${dto.status}`,
          { missing },
        );
      }
      await tx.prizeDelivery.update({
        where: { id: delivery.id },
        data: {
          status: dto.status,
          events: { create: { fromStatus: from, toStatus: dto.status, note: dto.note || null, actorId: actor.id } },
        },
      });
      // Staff notes stay internal; the winner sees the new status (and tracking details once dispatched).
      await this.notifications.notify(
        tx,
        before.userId,
        deliveryUpdated(auctionOf(before), id, dto.status, delivery.trackingInfo),
      );
      return toAdminDto(
        await this.record(tx, before, 'delivery.status', actor, ActorType.ADMIN, { from, to: dto.status }),
      );
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Row-locks the winner so two staff actions on it cannot interleave. */
  private async lock(tx: Tx, id: string): Promise<WinnerWithRelations> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM winners WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound();
    return tx.winner.findUniqueOrThrow({ where: { id }, include: winnerInclude });
  }

  private assertVerification(winner: WinnerWithRelations, allowed: WinnerVerificationStatus[], verb: string): void {
    if (!allowed.includes(winner.verificationStatus)) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.WINNER_INVALID_STATE,
        `A winner that is ${winner.verificationStatus} cannot be ${verb}`,
        { verificationStatus: winner.verificationStatus },
      );
    }
  }

  private deliveryOf(winner: WinnerWithRelations): NonNullable<WinnerWithRelations['delivery']> {
    if (!winner.delivery) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.WINNER_INVALID_STATE,
        'Prize delivery starts once the winner has been verified',
        { verificationStatus: winner.verificationStatus },
      );
    }
    return winner.delivery;
  }

  /** Reloads the winner and writes the audit record in the caller's transaction. */
  private async record(
    tx: Tx,
    before: WinnerWithRelations,
    action: string,
    actor: Actor,
    actorType: ActorType = ActorType.ADMIN,
    metadata?: Prisma.InputJsonObject,
  ): Promise<WinnerWithRelations> {
    const after = await tx.winner.findUniqueOrThrow({ where: { id: before.id }, include: winnerInclude });
    await this.audit.record(tx, {
      actorId: actor.id,
      actorType,
      action,
      entityType: 'winner',
      entityId: before.id,
      before: snapshot(before),
      after: snapshot(after),
      metadata: { auctionId: before.auctionId, ...metadata },
      client: actor.client,
    });
    return after;
  }
}
