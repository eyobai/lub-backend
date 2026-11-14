import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { AuctionsService } from './auctions.service';
import {
  AdminAuctionDto,
  AdminAuctionPageDto,
  AdminListAuctionsQueryDto,
  CancelAuctionDto,
  CreateAuctionDto,
  UpdateAuctionDto,
} from './dto/auction.dto';

const error = (description: string) => ({ description, type: ErrorResponseDto });
const NOT_READY =
  'AUCTION_NOT_READY — `details.problems` lists what is missing (no-unique-bid policy, product not AVAILABLE, dates in the past)';

/** Back-office staff can monitor auctions; only ADMIN (and SUPER_ADMIN) can create or change them. */
@ApiTags('Admin: Auctions')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin/auctions')
export class AdminAuctionsController {
  constructor(private readonly auctions: AuctionsService) {}

  @Get()
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'List auctions in any status',
    description: 'Roles: SUPPORT, FINANCE, ADMIN. Newest first.',
  })
  @ApiOkResponse({ type: AdminAuctionPageDto })
  list(@Query() query: AdminListAuctionsQueryDto): Promise<AdminAuctionPageDto> {
    return this.auctions.list(query);
  }

  @Get(':id')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({ summary: 'Get an auction in any status', description: 'Roles: SUPPORT, FINANCE, ADMIN.' })
  @ApiOkResponse({ type: AdminAuctionDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminAuctionDto> {
    return this.auctions.get(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Create an auction (as a draft)',
    description:
      'Role: ADMIN. The auction uses the currency of its product and stays invisible to users until it is ' +
      'scheduled or activated.',
  })
  @ApiCreatedResponse({ type: AdminAuctionDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED — includes inconsistent rules, listed in `details.fields`'))
  @ApiNotFoundResponse(error('NOT_FOUND — no such product'))
  @ApiUnprocessableEntityResponse(error('PRODUCT_NOT_AVAILABLE — the product is archived'))
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateAuctionDto,
    @Client() client: ClientInfo,
  ): Promise<AdminAuctionDto> {
    return this.auctions.create(actor.id, dto, client);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Edit an auction',
    description:
      'Role: ADMIN. Everything can be changed while the auction is DRAFT or SCHEDULED. Once it is ACTIVE only ' +
      'the title and description can change; after that nothing can.',
  })
  @ApiOkResponse({ type: AdminAuctionDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND — no such auction or product'))
  @ApiConflictResponse(error('AUCTION_INVALID_STATE'))
  @ApiUnprocessableEntityResponse(error(`PRODUCT_NOT_AVAILABLE, ${NOT_READY}`))
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAuctionDto,
    @Client() client: ClientInfo,
  ): Promise<AdminAuctionDto> {
    return this.auctions.update(actor.id, id, dto, client);
  }

  @Post(':id/schedule')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Schedule a draft',
    description: 'Role: ADMIN. DRAFT → SCHEDULED. Users can see the auction, and it opens by itself at `opensAt`.',
  })
  @ApiOkResponse({ type: AdminAuctionDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('AUCTION_INVALID_STATE — only a DRAFT can be scheduled'))
  @ApiUnprocessableEntityResponse(error(NOT_READY))
  schedule(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<AdminAuctionDto> {
    return this.auctions.schedule(actor.id, id, client);
  }

  @Post(':id/unschedule')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Return a scheduled auction to draft',
    description: 'Role: ADMIN. SCHEDULED → DRAFT. Hides the auction from users again.',
  })
  @ApiOkResponse({ type: AdminAuctionDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('AUCTION_INVALID_STATE — only a SCHEDULED auction can be unscheduled'))
  unschedule(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<AdminAuctionDto> {
    return this.auctions.unschedule(actor.id, id, client);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Open an auction for bidding now',
    description:
      'Role: ADMIN. DRAFT or SCHEDULED → ACTIVE immediately. If `opensAt` was still in the future it is set to now.',
  })
  @ApiOkResponse({ type: AdminAuctionDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('AUCTION_INVALID_STATE'))
  @ApiUnprocessableEntityResponse(error(NOT_READY))
  activate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<AdminAuctionDto> {
    return this.auctions.activate(actor.id, id, client);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Cancel an auction',
    description:
      'Role: ADMIN. DRAFT, SCHEDULED or ACTIVE → CANCELLED, with a reason. Bidding stops immediately and ' +
      'every bid fee already paid is refunded to the bidder’s wallet; `bidFeesRefundedAt` is set when all ' +
      'refunds are done.',
  })
  @ApiOkResponse({ type: AdminAuctionDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('AUCTION_INVALID_STATE'))
  cancel(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelAuctionDto,
    @Client() client: ClientInfo,
  ): Promise<AdminAuctionDto> {
    return this.auctions.cancel(actor.id, id, dto.reason, client);
  }
}
