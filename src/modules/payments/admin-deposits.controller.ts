import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
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
import { AdminDepositDto, AdminDepositPageDto, AdminListDepositsQueryDto, ResolveReviewDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });

/** Reading deposits is open to back-office staff; re-checking and closing a review is limited to FINANCE (and SUPER_ADMIN). */
@ApiTags('Admin: Payments')
@ApiBearerAuth()
@ApiBadRequestResponse(error('VALIDATION_FAILED — a malformed id, query parameter or body'))
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@ApiForbiddenResponse(error('FORBIDDEN — the signed-in user lacks the required role'))
@Controller('admin/deposits')
export class AdminDepositsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({
    summary: 'List deposits',
    description:
      'Newest first. `needsReview=true` lists the ones waiting for a person. Roles: SUPPORT, FINANCE, ADMIN.',
  })
  @ApiOkResponse({ type: AdminDepositPageDto })
  list(@Query() query: AdminListDepositsQueryDto): Promise<AdminDepositPageDto> {
    return this.payments.list(query);
  }

  @Get(':id')
  @Roles(RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN)
  @ApiOperation({ summary: 'Get one deposit', description: 'Roles: SUPPORT, FINANCE, ADMIN.' })
  @ApiOkResponse({ type: AdminDepositDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such deposit'))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminDepositDto> {
    return this.payments.getForAdmin(id);
  }

  @Post(':id/recheck')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.FINANCE)
  @ApiOperation({
    summary: 'Ask the provider about a deposit now',
    description:
      'For a user who paid but whose wallet was not credited. The wallet is credited only if the provider confirms ' +
      'a payment of the right amount; a deposit that already succeeded is returned unchanged. Roles: FINANCE.',
  })
  @ApiOkResponse({ type: AdminDepositDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such deposit'))
  @ApiBadGatewayResponse(error('PAYMENT_PROVIDER_ERROR — the provider could not be asked'))
  @ApiServiceUnavailableResponse(error('PAYMENTS_UNAVAILABLE — no payment provider is configured'))
  recheck(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ): Promise<AdminDepositDto> {
    return this.payments.recheck(actor.id, id, client);
  }

  @Post(':id/resolve-review')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.FINANCE)
  @ApiOperation({
    summary: 'Record that a flagged deposit has been dealt with',
    description:
      'Clears `reviewReason` and writes the note to the audit log. It moves no money: correct the wallet with a ' +
      'manual adjustment first if that is needed. Roles: FINANCE.',
  })
  @ApiOkResponse({ type: AdminDepositDto })
  @ApiNotFoundResponse(error('NOT_FOUND — no such deposit'))
  @ApiConflictResponse(error('CONFLICT — the deposit is not waiting for review'))
  resolveReview(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReviewDto,
    @Client() client: ClientInfo,
  ): Promise<AdminDepositDto> {
    return this.payments.resolveReview(actor.id, id, dto.note, client);
  }
}
