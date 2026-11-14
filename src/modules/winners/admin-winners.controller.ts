import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import {
  AdminListWinnersQueryDto,
  AdminWinnerDto,
  AdminWinnerPageDto,
  RejectWinnerDto,
  SetDeliveryStatusDto,
  UpdateDeliveryDto,
  VerifyWinnerDto,
} from './dto/winner.dto';
import { WinnersService } from './winners.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });

/** Reading is open to back-office staff; verifying and publishing is ADMIN only; delivery is handled by SUPPORT and ADMIN. */
@ApiTags('Admin: Winners')
@ApiBearerAuth()
@ApiBadRequestResponse(error('VALIDATION_FAILED — a malformed id, query parameter or body'))
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin/winners')
export class AdminWinnersController {
  constructor(private readonly winners: WinnersService) {}

  @Get()
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({ summary: 'List winners', description: 'Roles: SUPPORT, FINANCE, ADMIN. Newest first.' })
  @ApiOkResponse({ type: AdminWinnerPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  list(@Query() query: AdminListWinnersQueryDto): Promise<AdminWinnerPageDto> {
    return this.winners.list(query);
  }

  @Get(':id')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'Get a winner',
    description: 'Roles: SUPPORT, FINANCE, ADMIN. Includes the delivery and its status history.',
  })
  @ApiOkResponse({ type: AdminWinnerDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminWinnerDto> {
    return this.winners.get(id);
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Verify a winner',
    description:
      'Role: ADMIN. PENDING_VERIFICATION or REJECTED → VERIFIED. The result is recomputed from the bids on ' +
      'record first and must still name the same winning bid. Verifying opens the prize delivery (PENDING).',
  })
  @ApiOkResponse({ type: AdminWinnerDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('WINNER_INVALID_STATE, RESULT_MISMATCH'))
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyWinnerDto,
    @Client() client: ClientInfo,
  ): Promise<AdminWinnerDto> {
    return this.winners.verify({ id: user.id, client }, id, dto.note);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Reject a winner',
    description:
      'Role: ADMIN. PENDING_VERIFICATION → REJECTED, with a reason. The auction result stays on record and ' +
      'no other winner is chosen. A rejected winner can still be verified later.',
  })
  @ApiOkResponse({ type: AdminWinnerDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('WINNER_INVALID_STATE'))
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectWinnerDto,
    @Client() client: ClientInfo,
  ): Promise<AdminWinnerDto> {
    return this.winners.reject({ id: user.id, client }, id, dto.reason);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({
    summary: 'Publish a winner',
    description: 'Role: ADMIN. Shows a VERIFIED winner in the public recent-winners list.',
  })
  @ApiOkResponse({ type: AdminWinnerDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('WINNER_INVALID_STATE — only verified winners can be published'))
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<AdminWinnerDto> {
    return this.winners.publish({ id: user.id, client }, id);
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOperation({ summary: 'Unpublish a winner', description: 'Role: ADMIN. Removes the winner from the public list.' })
  @ApiOkResponse({ type: AdminWinnerDto })
  @ApiNotFoundResponse(error('NOT_FOUND'))
  unpublish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<AdminWinnerDto> {
    return this.winners.unpublish({ id: user.id, client }, id);
  }

  @Patch(':id/delivery')
  @Roles(RoleName.SUPPORT, RoleName.ADMIN)
  @ApiOperation({
    summary: 'Update delivery details',
    description: 'Roles: SUPPORT, ADMIN. Recipient, address, tracking information and internal notes.',
  })
  @ApiOkResponse({ type: AdminWinnerDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('WINNER_INVALID_STATE — the winner is not verified yet'))
  updateDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliveryDto,
    @Client() client: ClientInfo,
  ): Promise<AdminWinnerDto> {
    return this.winners.updateDelivery({ id: user.id, client }, id, dto);
  }

  @Post(':id/delivery/status')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.SUPPORT, RoleName.ADMIN)
  @ApiOperation({
    summary: 'Move the delivery to another status',
    description:
      'Roles: SUPPORT, ADMIN. PENDING → CONTACTED → VERIFIED → DISPATCHED → DELIVERED, one step at a time. ' +
      'DISPUTED can be set from any status and left for any later step; both need a note. DISPATCHED and ' +
      'DELIVERED need the recipient name, phone and address. Every change is kept in the status history.',
  })
  @ApiOkResponse({ type: AdminWinnerDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  @ApiNotFoundResponse(error('NOT_FOUND'))
  @ApiConflictResponse(error('DELIVERY_INVALID_STATE — `details.allowedNextStatuses` lists what is possible'))
  @ApiUnprocessableEntityResponse(error('DELIVERY_DETAILS_REQUIRED — `details.missing` lists what to provide'))
  setDeliveryStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetDeliveryStatusDto,
    @Client() client: ClientInfo,
  ): Promise<AdminWinnerDto> {
    return this.winners.setDeliveryStatus({ id: user.id, client }, id, dto);
  }
}
