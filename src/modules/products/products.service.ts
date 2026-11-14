import { HttpStatus, Injectable } from '@nestjs/common';
import { ActorType, AuctionStatus, Prisma, ProductStatus } from '@prisma/client';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { paging } from '../../common/dto/page-query.dto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { formatMinor } from '../../common/utils/money';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrencyService } from '../currency/currency.service';
import type {
  CreateProductDto,
  ListProductsQueryDto,
  ProductDto,
  ProductImageInputDto,
  ProductPageDto,
  ProductSummaryDto,
  SpecificationValue,
  UpdateProductDto,
} from './dto/product.dto';

export const productInclude = {
  images: { orderBy: { sortOrder: 'asc' } },
  currencyRef: true,
} satisfies Prisma.ProductInclude;
export type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

/** Auction states in which the product is promised to bidders and must stay AVAILABLE. */
export const LIVE_AUCTION_STATUSES: AuctionStatus[] = [
  AuctionStatus.SCHEDULED,
  AuctionStatus.ACTIVE,
  AuctionStatus.CLOSING,
];

export function toProductSummary(product: ProductWithRelations): ProductSummaryDto {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    brand: product.brand,
    model: product.model,
    currency: product.currency,
    marketValueMinor: product.marketValueMinor.toString(),
    marketValue: formatMinor(product.marketValueMinor, product.currencyRef.minorUnits),
    specifications: product.specifications as Record<string, SpecificationValue> | null,
    images: product.images.map(({ id, url, altText, sortOrder }) => ({ id, url, altText, sortOrder })),
  };
}

function toProductDto(product: ProductWithRelations): ProductDto {
  return {
    ...toProductSummary(product),
    status: product.status,
    createdById: product.createdById,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/** JSON-safe copy for the audit log. */
function snapshot(product: ProductWithRelations): Prisma.InputJsonObject {
  const { images, ...rest } = toProductSummary(product);
  return { ...rest, status: product.status, images: images.map(({ url, altText }) => ({ url, altText })) };
}

const imageRows = (productId: string, images: ProductImageInputDto[]) =>
  images.map((image, sortOrder) => ({ productId, url: image.url, altText: image.altText || null, sortOrder }));

const notFound = () => new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Product not found');

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly currencies: CurrencyService,
  ) {}

  async list(query: ListProductsQueryDto): Promise<ProductPageDto> {
    const { page, limit, skip } = paging(query);
    const contains = query.search ? { contains: query.search, mode: 'insensitive' as const } : undefined;
    const where: Prisma.ProductWhereInput = {
      status: query.status,
      ...(contains ? { OR: [{ name: contains }, { brand: contains }, { model: contains }] } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: productInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items: items.map(toProductDto), total, page, limit };
  }

  async get(id: string): Promise<ProductDto> {
    const product = await this.prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!product) throw notFound();
    return toProductDto(product);
  }

  async create(actorId: string, dto: CreateProductDto, client: ClientInfo): Promise<ProductDto> {
    const currency = await this.currencies.resolve(dto.currency);
    return this.prisma.$transaction(async (tx) => {
      const { id } = await tx.product.create({
        data: {
          name: dto.name,
          description: dto.description || null,
          brand: dto.brand || null,
          model: dto.model || null,
          marketValueMinor: BigInt(dto.marketValueMinor),
          currency: currency.code,
          specifications: dto.specifications ?? Prisma.DbNull,
          status: dto.status ?? ProductStatus.AVAILABLE,
          createdById: actorId,
        },
      });
      if (dto.images?.length) await tx.productImage.createMany({ data: imageRows(id, dto.images) });
      const product = await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });
      await this.audit.record(tx, {
        actorId,
        actorType: ActorType.ADMIN,
        action: 'product.create',
        entityType: 'product',
        entityId: id,
        after: snapshot(product),
        client,
      });
      return toProductDto(product);
    });
  }

  async update(actorId: string, id: string, dto: UpdateProductDto, client: ClientInfo): Promise<ProductDto> {
    if (Object.values(dto).every((value) => value === undefined)) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, 'Send at least one field to change');
    }
    return this.prisma.$transaction(async (tx) => {
      // The row lock serializes this with auctions being scheduled on the product (they take a share lock).
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw notFound();
      const before = await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });

      if (dto.status !== undefined && dto.status !== ProductStatus.AVAILABLE && dto.status !== before.status) {
        const live = await tx.auction.count({ where: { productId: id, status: { in: LIVE_AUCTION_STATUSES } } });
        if (live > 0) {
          throw new AppException(
            HttpStatus.CONFLICT,
            ErrorCode.PRODUCT_IN_USE,
            'This product has a scheduled or running auction and must stay AVAILABLE until it ends or is cancelled',
            { liveAuctions: live },
          );
        }
      }

      await tx.product.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description === undefined ? undefined : dto.description || null,
          brand: dto.brand === undefined ? undefined : dto.brand || null,
          model: dto.model === undefined ? undefined : dto.model || null,
          marketValueMinor: dto.marketValueMinor === undefined ? undefined : BigInt(dto.marketValueMinor),
          specifications: dto.specifications === null ? Prisma.DbNull : dto.specifications,
          status: dto.status,
        },
      });
      if (dto.images !== undefined) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        if (dto.images.length) await tx.productImage.createMany({ data: imageRows(id, dto.images) });
      }

      const after = await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });
      await this.audit.record(tx, {
        actorId,
        actorType: ActorType.ADMIN,
        action: 'product.update',
        entityType: 'product',
        entityId: id,
        before: snapshot(before),
        after: snapshot(after),
        client,
      });
      return toProductDto(after);
    });
  }
}
