import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import {
  CreateProductDto,
  ListProductsQueryDto,
  ProductDto,
  ProductPageDto,
  UpdateProductDto,
} from './dto/product.dto';
import { ProductsService } from './products.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });

/** Back-office staff can read the catalogue; only ADMIN (and SUPER_ADMIN) can change it. */
@ApiTags('Admin: Products')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({ summary: 'List products', description: 'Roles: SUPPORT, FINANCE, ADMIN. Newest first.' })
  @ApiOkResponse({ type: ProductPageDto })
  list(@Query() query: ListProductsQueryDto): Promise<ProductPageDto> {
    return this.products.list(query);
  }

  @Get(':id')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({ summary: 'Get a product', description: 'Roles: SUPPORT, FINANCE, ADMIN.' })
  @ApiOkResponse({ type: ProductDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ProductDto> {
    return this.products.get(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Create a product',
    description: 'Role: ADMIN. A product can be used by any number of auctions. Its currency cannot be changed later.',
  })
  @ApiCreatedResponse({ type: ProductDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, CURRENCY_NOT_SUPPORTED'))
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateProductDto,
    @Client() client: ClientInfo,
  ): Promise<ProductDto> {
    return this.products.create(actor.id, dto, client);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Update a product',
    description:
      'Role: ADMIN. Send only the fields to change. Products are never deleted: set status ARCHIVED to retire one.',
  })
  @ApiOkResponse({ type: ProductDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('PRODUCT_IN_USE — it has a scheduled or running auction and must stay AVAILABLE'))
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @Client() client: ClientInfo,
  ): Promise<ProductDto> {
    return this.products.update(actor.id, id, dto, client);
  }
}
