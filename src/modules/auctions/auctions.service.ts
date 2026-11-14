import { HttpStatus, Injectable } from '@nestjs/common';
import { ActorType, AuctionStatus, ProductStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { paging } from '../../common/dto/page-query.dto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { formatMinor } from '../../common/utils/money';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { productInclude, toProductSummary } from '../products/products.service';
import { configProblems, EDITABLE_STATUSES, readinessProblems } from './auction-rules';
import { PUBLIC_AUCTION_STATUSES } from './dto/auction.dto';
import type {
  AdminAuctionDto,
  AdminAuctionPageDto,
  AdminListAuctionsQueryDto,
  AuctionDto,
  AuctionPageDto,
  CreateAuctionDto,
  ListAuctionsQueryDto,
  UpdateAuctionDto,
} from './dto/auction.dto';

type Tx = Prisma.TransactionClient;

const auctionInclude = {
  product: { include: productInclude },
  currencyRef: true,
} satisfies Prisma.AuctionInclude;
type AuctionWithRelations = Prisma.AuctionGetPayload<{ include: typeof auctionInclude }>;

/** Once bidding is open only the wording may change; the rules bidders rely on are fixed. */
const EDITABLE_WHILE_ACTIVE: (keyof UpdateAuctionDto)[] = ['title', 'description'];

/** Visitors see upcoming, running and finished auctions, plus cancelled ones that had been open for bidding. */
const publicWhere = (status?: AuctionStatus): Prisma.AuctionWhereInput =>
  status
    ? { status }
    : {
        OR: [
          { status: { in: PUBLIC_AUCTION_STATUSES } },
          { status: AuctionStatus.CANCELLED, activatedAt: { not: null } },
        ],
      };

function toAuctionDto(a: AuctionWithRelations, serverTime: Date): AuctionDto {
  const money = (value: bigint) => formatMinor(value, a.currencyRef.minorUnits);
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    status: a.status,
    currency: a.currency,
    minorUnits: a.currencyRef.minorUnits,
    bidFeeMinor: a.bidFeeMinor.toString(),
    bidFee: money(a.bidFeeMinor),
    minBidMinor: a.minBidMinor.toString(),
    minBid: money(a.minBidMinor),
    maxBidMinor: a.maxBidMinor.toString(),
    maxBid: money(a.maxBidMinor),
    bidStepMinor: a.bidStepMinor.toString(),
    bidStep: money(a.bidStepMinor),
    maxBidsPerUser: a.maxBidsPerUser,
    maxBidsPerRequest: a.maxBidsPerRequest,
    duplicateBidPolicy: a.duplicateBidPolicy,
    noUniqueBidPolicy: a.noUniqueBidPolicy,
    opensAt: a.opensAt,
    closesAt: a.closesAt,
    totalBidCount: a.totalBidCount,
    product: toProductSummary(a.product),
    serverTime,
  };
}

function toAdminDto(a: AuctionWithRelations, serverTime: Date): AdminAuctionDto {
  return {
    ...toAuctionDto(a, serverTime),
    productStatus: a.product.status,
    version: a.version,
    createdById: a.createdById,
    activatedAt: a.activatedAt,
    closedAt: a.closedAt,
    completedAt: a.completedAt,
    cancelledAt: a.cancelledAt,
    cancelReason: a.cancelReason,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** JSON-safe copy for the audit log. */
function snapshot(a: AuctionWithRelations): Prisma.InputJsonObject {
  return {
    status: a.status,
    productId: a.productId,
    title: a.title,
    description: a.description,
    currency: a.currency,
    bidFeeMinor: a.bidFeeMinor.toString(),
    minBidMinor: a.minBidMinor.toString(),
    maxBidMinor: a.maxBidMinor.toString(),
    bidStepMinor: a.bidStepMinor.toString(),
    maxBidsPerUser: a.maxBidsPerUser,
    maxBidsPerRequest: a.maxBidsPerRequest,
    duplicateBidPolicy: a.duplicateBidPolicy,
    noUniqueBidPolicy: a.noUniqueBidPolicy,
    opensAt: a.opensAt.toISOString(),
    closesAt: a.closesAt.toISOString(),
    cancelReason: a.cancelReason,
  };
}

const notFound = () => new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Auction not found');

@Injectable()
export class AuctionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Public ─────────────────────────────────────────────────────────────────

  async listPublic(query: ListAuctionsQueryDto): Promise<AuctionPageDto> {
    const { page, limit, skip } = paging(query);
    const where = publicWhere(query.status);
    const [items, total, now] = await Promise.all([
      this.prisma.auction.findMany({
        where,
        include: auctionInclude,
        orderBy: [{ [query.sort ?? 'closesAt']: query.order ?? 'asc' }, { id: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.auction.count({ where }),
      this.now(),
    ]);
    return { items: items.map((a) => toAuctionDto(a, now)), total, page, limit };
  }

  async getPublic(id: string): Promise<AuctionDto> {
    const auction = await this.prisma.auction.findFirst({ where: { id, ...publicWhere() }, include: auctionInclude });
    if (!auction) throw notFound();
    return toAuctionDto(auction, await this.now());
  }

  // ── Back office ────────────────────────────────────────────────────────────

  async list(query: AdminListAuctionsQueryDto): Promise<AdminAuctionPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.AuctionWhereInput = {
      status: query.status,
      productId: query.productId,
      title: query.search ? { contains: query.search, mode: 'insensitive' } : undefined,
    };
    const [items, total, now] = await Promise.all([
      this.prisma.auction.findMany({
        where,
        include: auctionInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.auction.count({ where }),
      this.now(),
    ]);
    return { items: items.map((a) => toAdminDto(a, now)), total, page, limit };
  }

  async get(id: string): Promise<AdminAuctionDto> {
    const auction = await this.prisma.auction.findUnique({ where: { id }, include: auctionInclude });
    if (!auction) throw notFound();
    return toAdminDto(auction, await this.now());
  }

  /** Creates a DRAFT. Nothing is visible to users until the auction is scheduled or activated. */
  async create(actorId: string, dto: CreateAuctionDto, client: ClientInfo): Promise<AdminAuctionDto> {
    const data = {
      title: dto.title,
      description: dto.description || null,
      bidFeeMinor: BigInt(dto.bidFeeMinor),
      minBidMinor: BigInt(dto.minBidMinor),
      maxBidMinor: BigInt(dto.maxBidMinor),
      bidStepMinor: BigInt(dto.bidStepMinor ?? '1'),
      maxBidsPerUser: dto.maxBidsPerUser ?? null,
      maxBidsPerRequest: dto.maxBidsPerRequest ?? 50,
      opensAt: new Date(dto.opensAt),
      closesAt: new Date(dto.closesAt),
      duplicateBidPolicy: dto.duplicateBidPolicy,
      noUniqueBidPolicy: dto.noUniqueBidPolicy ?? null,
    };
    assertValidConfig(data);

    return this.prisma.$transaction(async (tx) => {
      const product = await this.usableProduct(tx, dto.productId);
      const { id } = await tx.auction.create({
        data: { ...data, productId: product.id, currency: product.currency, createdById: actorId },
      });
      const auction = await tx.auction.findUniqueOrThrow({ where: { id }, include: auctionInclude });
      await this.audit.record(tx, {
        actorId,
        actorType: ActorType.ADMIN,
        action: 'auction.create',
        entityType: 'auction',
        entityId: id,
        after: snapshot(auction),
        client,
      });
      return toAdminDto(auction, await this.now(tx));
    });
  }

  async update(actorId: string, id: string, dto: UpdateAuctionDto, client: ClientInfo): Promise<AdminAuctionDto> {
    const changed = (Object.keys(dto) as (keyof UpdateAuctionDto)[]).filter((key) => dto[key] !== undefined);
    if (changed.length === 0) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Send at least one field to change');
    }

    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status === AuctionStatus.ACTIVE) {
        const locked = changed.filter((key) => !EDITABLE_WHILE_ACTIVE.includes(key));
        if (locked.length > 0) {
          throw new AppException(
            HttpStatus.CONFLICT,
            ErrorCode.AUCTION_INVALID_STATE,
            'Bidding is open: only the title and description can still be changed',
            { status: before.status, lockedFields: locked },
          );
        }
      } else {
        assertStatus(before, EDITABLE_STATUSES, 'edited');
      }

      const data = {
        title: dto.title,
        description: dto.description === undefined ? undefined : dto.description || null,
        bidFeeMinor: dto.bidFeeMinor === undefined ? undefined : BigInt(dto.bidFeeMinor),
        minBidMinor: dto.minBidMinor === undefined ? undefined : BigInt(dto.minBidMinor),
        maxBidMinor: dto.maxBidMinor === undefined ? undefined : BigInt(dto.maxBidMinor),
        bidStepMinor: dto.bidStepMinor === undefined ? undefined : BigInt(dto.bidStepMinor),
        maxBidsPerUser: dto.maxBidsPerUser,
        maxBidsPerRequest: dto.maxBidsPerRequest,
        opensAt: dto.opensAt === undefined ? undefined : new Date(dto.opensAt),
        closesAt: dto.closesAt === undefined ? undefined : new Date(dto.closesAt),
        duplicateBidPolicy: dto.duplicateBidPolicy,
        noUniqueBidPolicy: dto.noUniqueBidPolicy,
      };
      const merged = {
        bidFeeMinor: data.bidFeeMinor ?? before.bidFeeMinor,
        minBidMinor: data.minBidMinor ?? before.minBidMinor,
        maxBidMinor: data.maxBidMinor ?? before.maxBidMinor,
        bidStepMinor: data.bidStepMinor ?? before.bidStepMinor,
        opensAt: data.opensAt ?? before.opensAt,
        closesAt: data.closesAt ?? before.closesAt,
        noUniqueBidPolicy: data.noUniqueBidPolicy === undefined ? before.noUniqueBidPolicy : data.noUniqueBidPolicy,
      };
      assertValidConfig(merged);

      // The auction's currency always follows its product.
      const product =
        dto.productId !== undefined && dto.productId !== before.productId
          ? await this.usableProduct(tx, dto.productId)
          : undefined;
      if (before.status === AuctionStatus.SCHEDULED) {
        // A scheduled auction is already promised to users, so it has to stay publishable.
        const productStatus = await this.lockProductStatus(tx, product?.id ?? before.productId);
        assertReady(readinessProblems({ ...merged, productStatus }, await this.now(tx), 'schedule'));
      }

      await tx.auction.update({
        where: { id },
        data: { ...data, productId: product?.id, currency: product?.currency, version: { increment: 1 } },
      });
      return this.finish(tx, before, 'auction.update', actorId, client);
    });
  }

  /** DRAFT → SCHEDULED: users can see it, and it opens by itself at `opensAt`. */
  schedule(actorId: string, id: string, client: ClientInfo): Promise<AdminAuctionDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      assertStatus(before, [AuctionStatus.DRAFT], 'scheduled');
      const productStatus = await this.lockProductStatus(tx, before.productId);
      assertReady(readinessProblems({ ...before, productStatus }, await this.now(tx), 'schedule'));

      await tx.auction.update({
        where: { id },
        data: { status: AuctionStatus.SCHEDULED, version: { increment: 1 } },
      });
      return this.finish(tx, before, 'auction.schedule', actorId, client);
    });
  }

  /** SCHEDULED → DRAFT: takes it out of public view again. */
  unschedule(actorId: string, id: string, client: ClientInfo): Promise<AdminAuctionDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      assertStatus(before, [AuctionStatus.SCHEDULED], 'unscheduled');
      await tx.auction.update({ where: { id }, data: { status: AuctionStatus.DRAFT, version: { increment: 1 } } });
      return this.finish(tx, before, 'auction.unschedule', actorId, client);
    });
  }

  /** DRAFT or SCHEDULED → ACTIVE now, without waiting for `opensAt`. */
  activate(actorId: string, id: string, client: ClientInfo): Promise<AdminAuctionDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      assertStatus(before, EDITABLE_STATUSES, 'activated');
      const productStatus = await this.lockProductStatus(tx, before.productId);
      const now = await this.now(tx);
      assertReady(readinessProblems({ ...before, productStatus }, now, 'activate'));

      await tx.auction.update({
        where: { id },
        data: {
          status: AuctionStatus.ACTIVE,
          activatedAt: now,
          // Opened early: record the real opening time so the published window is truthful.
          opensAt: before.opensAt > now ? now : undefined,
          version: { increment: 1 },
        },
      });
      return this.finish(tx, before, 'auction.activate', actorId, client);
    });
  }

  cancel(actorId: string, id: string, reason: string, client: ClientInfo): Promise<AdminAuctionDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      assertStatus(before, [...EDITABLE_STATUSES, AuctionStatus.ACTIVE], 'cancelled');
      if (before.totalBidCount > 0) {
        // Cancelling after bids were paid for must refund them; that arrives with the bidding module.
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.AUCTION_HAS_BIDS,
          'This auction already has bids, so it cannot be cancelled without refunding them',
          { totalBidCount: before.totalBidCount },
        );
      }
      await tx.auction.update({
        where: { id },
        data: {
          status: AuctionStatus.CANCELLED,
          cancelledAt: await this.now(tx),
          cancelReason: reason,
          version: { increment: 1 },
        },
      });
      return this.finish(tx, before, 'auction.cancel', actorId, client, { reason });
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Row-locks the auction so admin actions and the background open/close sweep cannot interleave. */
  private async lock(tx: Tx, id: string): Promise<AuctionWithRelations> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM auctions WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound();
    return tx.auction.findUniqueOrThrow({ where: { id }, include: auctionInclude });
  }

  /** Share-locks the product so its status cannot change while an auction is being published on it. */
  private async lockProductStatus(tx: Tx, productId: string): Promise<ProductStatus> {
    const rows = await tx.$queryRaw<{ status: ProductStatus }[]>`
      SELECT status::text AS status FROM products WHERE id = ${productId}::uuid FOR SHARE`;
    return rows[0].status;
  }

  private async usableProduct(tx: Tx, productId: string): Promise<{ id: string; currency: string }> {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, currency: true, status: true },
    });
    if (!product) throw new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Product not found');
    if (product.status === ProductStatus.ARCHIVED) {
      throw new AppException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.PRODUCT_NOT_AVAILABLE,
        'This product is archived and cannot be put up for auction',
      );
    }
    return product;
  }

  private async finish(
    tx: Tx,
    before: AuctionWithRelations,
    action: string,
    actorId: string,
    client: ClientInfo,
    metadata?: Prisma.InputJsonObject,
  ): Promise<AdminAuctionDto> {
    const after = await tx.auction.findUniqueOrThrow({ where: { id: before.id }, include: auctionInclude });
    await this.audit.record(tx, {
      actorId,
      actorType: ActorType.ADMIN,
      action,
      entityType: 'auction',
      entityId: before.id,
      before: snapshot(before),
      after: snapshot(after),
      metadata,
      client,
    });
    return toAdminDto(after, await this.now(tx));
  }

  /** The database clock: the single authority for opening and closing times. */
  private async now(db: Tx = this.prisma): Promise<Date> {
    const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return row.now;
  }
}

function assertValidConfig(config: Parameters<typeof configProblems>[0]): void {
  const problems = configProblems(config);
  if (problems.length > 0) {
    throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Request validation failed', {
      fields: problems,
    });
  }
}

function assertReady(problems: string[]): void {
  if (problems.length > 0) {
    throw new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.AUCTION_NOT_READY,
      'This auction is not ready to be published',
      { problems },
    );
  }
}

function assertStatus(auction: { status: AuctionStatus }, allowed: AuctionStatus[], verb: string): void {
  if (!allowed.includes(auction.status)) {
    throw new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.AUCTION_INVALID_STATE,
      `A ${auction.status} auction cannot be ${verb}`,
      { status: auction.status, allowedStatuses: allowed },
    );
  }
}
