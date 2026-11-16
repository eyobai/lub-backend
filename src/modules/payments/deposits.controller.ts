import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Client } from '../../common/decorators/client-info.decorator';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { DepositDto, DepositOptionsDto, DepositPageDto, StartDepositDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });
const REPLAYED_HEADER = 'Idempotent-Replayed';

@ApiTags('Wallet')
@ApiBearerAuth()
@ApiUnauthorizedResponse(error('UNAUTHORIZED'))
@Controller('wallet')
export class DepositsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('deposit-options')
  @ApiOperation({
    summary: 'Whether money can be added online, and the limits',
    description: 'Ask this before showing an "add money" form.',
  })
  @ApiOkResponse({ type: DepositOptionsDto })
  options(): Promise<DepositOptionsDto> {
    return this.payments.options();
  }

  @Post('deposits')
  @ApiOperation({
    summary: 'Start adding money to my wallet',
    description:
      'Opens a payment at the provider and answers with `checkoutUrl`: send the user there to pay. ' +
      'No money is added by this call. The wallet is credited once the server has confirmed the payment with ' +
      'the provider; read the deposit again (`GET /wallet/deposits/{id}`) to see when that has happened. ' +
      'The provider sends the user back to the website at `/wallet/deposits/{id}`.',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Unique key for this deposit (e.g. a UUID). Retrying with the same key returns the same deposit ' +
      `with the response header \`${REPLAYED_HEADER}: true\` instead of opening a second payment.`,
  })
  @ApiCreatedResponse({ type: DepositDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED, IDEMPOTENCY_KEY_REQUIRED'))
  @ApiForbiddenResponse(error('FORBIDDEN — staff accounts cannot add money; WALLET_FROZEN'))
  @ApiUnprocessableEntityResponse(
    error('DEPOSIT_AMOUNT_INVALID — outside the limits (details carry them); IDEMPOTENCY_KEY_REUSED'),
  )
  @ApiTooManyRequestsResponse(error('DEPOSIT_LIMIT_REACHED — too many deposits are waiting for payment'))
  @ApiBadGatewayResponse(error('PAYMENT_PROVIDER_ERROR — the provider could not open the payment; nothing was taken'))
  @ApiServiceUnavailableResponse(error('PAYMENTS_UNAVAILABLE — no payment provider is configured'))
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body() dto: StartDepositDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DepositDto> {
    const { deposit, replayed } = await this.payments.start(user, idempotencyKey, BigInt(dto.amountMinor), client);
    if (replayed) res.setHeader(REPLAYED_HEADER, 'true');
    return deposit;
  }

  @Get('deposits')
  @ApiOperation({ summary: 'List my deposits', description: 'Newest first.' })
  @ApiOkResponse({ type: DepositPageDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED'))
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PageQueryDto): Promise<DepositPageDto> {
    return this.payments.listMine(user.id, query);
  }

  @Get('deposits/:id')
  @ApiOperation({
    summary: 'Get one of my deposits',
    description:
      'While the deposit is PENDING the server asks the provider again (at most every few seconds), so this is ' +
      'the call to repeat on the page the user returns to after paying.',
  })
  @ApiOkResponse({ type: DepositDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED — malformed id'))
  @ApiNotFoundResponse(error('NOT_FOUND — no such deposit of mine'))
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string): Promise<DepositDto> {
    return this.payments.getMine(user.id, id);
  }
}
