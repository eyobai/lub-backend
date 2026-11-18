import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidateNested,
} from 'class-validator';
import type { ValidationOptions } from 'class-validator';
import { CurrencyCode } from '../../../common/dto/currency-code.decorator';
import { PageQueryDto } from '../../../common/dto/page-query.dto';
import { Trim } from '../../../common/utils/trim.transform';
import { IsUndefinable } from '../../../common/validators/validators';

const MAX_IMAGES = 10;
const MAX_SPEC_ENTRIES = 50;

export type SpecificationValue = string | number | boolean;

/** Product specifications: a flat object of label → text, number or boolean. */
export function isSpecifications(value: unknown): value is Record<string, SpecificationValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_SPEC_ENTRIES) return false;
  return entries.every(([key, v]) => {
    if (key.trim().length === 0 || key.length > 100) return false;
    if (typeof v === 'string') return v.length <= 1000;
    if (typeof v === 'number') return Number.isFinite(v);
    return typeof v === 'boolean';
  });
}

function IsSpecifications(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isSpecifications',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a flat object of up to ${MAX_SPEC_ENTRIES} entries whose values are text, numbers or booleans`,
        ...options,
      },
      validator: { validate: isSpecifications },
    });
}

export class ProductImageInputDto {
  @ApiProperty({ example: 'https://cdn.example.com/products/phone-front.jpg', maxLength: 2048 })
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional({ example: 'Front view', maxLength: 255, type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(255)
  altText?: string | null;
}

export class CreateProductDto {
  @ApiProperty({ example: 'Samsung Galaxy A55', minLength: 2, maxLength: 200 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ maxLength: 10000, type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(10000)
  description?: string | null;

  @ApiPropertyOptional({ example: 'Samsung', maxLength: 100, type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  brand?: string | null;

  @ApiPropertyOptional({ example: 'SM-A556E', maxLength: 100, type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  model?: string | null;

  @CurrencyCode()
  currency?: string;

  @ApiPropertyOptional({
    example: { Storage: '256 GB', 'Screen size (in)': 6.6, '5G': true },
    description: 'Flat object of label → text, number or boolean (up to 50 entries).',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsSpecifications()
  specifications?: Record<string, SpecificationValue> | null;

  @ApiPropertyOptional({
    type: [ProductImageInputDto],
    maxItems: MAX_IMAGES,
    description: 'Image URLs in display order. Files are hosted elsewhere; only the links are stored.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_IMAGES)
  @ValidateNested({ each: true })
  @Type(() => ProductImageInputDto)
  images?: ProductImageInputDto[];

  @ApiPropertyOptional({ enum: ProductStatus, default: ProductStatus.AVAILABLE })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}

/** Send only the fields to change. `null` clears description, brand, model or specifications. */
export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 200 })
  @IsUndefinable()
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 10000, type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(10000)
  description?: string | null;

  @ApiPropertyOptional({ maxLength: 100, type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  brand?: string | null;

  @ApiPropertyOptional({ maxLength: 100, type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  model?: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  @IsOptional()
  @IsSpecifications()
  specifications?: Record<string, SpecificationValue> | null;

  @ApiPropertyOptional({
    type: [ProductImageInputDto],
    maxItems: MAX_IMAGES,
    description: 'Replaces the whole image list, in display order. Send [] to remove all images.',
  })
  @IsUndefinable()
  @IsArray()
  @ArrayMaxSize(MAX_IMAGES)
  @ValidateNested({ each: true })
  @Type(() => ProductImageInputDto)
  images?: ProductImageInputDto[];

  @ApiPropertyOptional({
    enum: ProductStatus,
    description: 'A product with a scheduled or running auction must stay AVAILABLE.',
  })
  @IsUndefinable()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}

export class ListProductsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ProductStatus })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({ description: 'Matches name, brand or model (case-insensitive)', maxLength: 100 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class ProductImageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty({ type: String, nullable: true })
  altText!: string | null;

  @ApiProperty({ description: 'Display position, starting at 0' })
  sortOrder!: number;
}

/** What buyers see of a product. */
export class ProductSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  brand!: string | null;

  @ApiProperty({ type: String, nullable: true })
  model!: string | null;

  @ApiProperty({ example: 'ETB' })
  currency!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  specifications!: Record<string, SpecificationValue> | null;

  @ApiProperty({ type: [ProductImageDto] })
  images!: ProductImageDto[];
}

export class ProductDto extends ProductSummaryDto {
  @ApiProperty({ enum: ProductStatus })
  status!: ProductStatus;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class ProductPageDto {
  @ApiProperty({ type: [ProductDto] })
  items!: ProductDto[];

  @ApiProperty({ description: 'Number of products matching the filter' })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}
