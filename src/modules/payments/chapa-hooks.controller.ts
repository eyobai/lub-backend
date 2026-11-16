import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AllowPendingPasswordChange } from '../../common/decorators/allow-pending-password-change.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { WebhookAckDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

const error = (description: string) => ({ description, type: ErrorResponseDto });

/** Called by Chapa, not by our own clients. Neither route trusts what it is told: both lead to a check with Chapa. */
@ApiTags('Payments')
@Public()
@AllowPendingPasswordChange()
@Controller('payments/chapa')
export class ChapaHooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Chapa webhook',
    description:
      'Set this address as the webhook URL in the Chapa dashboard, with the same secret as CHAPA_WEBHOOK_SECRET. ' +
      'The request must carry a valid `x-chapa-signature` or `chapa-signature`. The event is stored as received, ' +
      'handled once, and the payment it names is verified with Chapa before any wallet is credited.',
  })
  @ApiHeader({ name: 'x-chapa-signature', required: false, description: 'HMAC-SHA256 of the body with the secret' })
  @ApiHeader({ name: 'chapa-signature', required: false, description: 'HMAC-SHA256 of the secret with the secret' })
  @ApiOkResponse({ type: WebhookAckDto })
  @ApiBadRequestResponse(error('VALIDATION_FAILED — the body is not a JSON object'))
  @ApiUnauthorizedResponse(error('WEBHOOK_SIGNATURE_INVALID'))
  @ApiServiceUnavailableResponse(error('SERVICE_BUSY — Chapa could not be asked; it will send the event again'))
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, unknown>,
    @Body() body: unknown,
  ): Promise<WebhookAckDto> {
    // The signature covers the bytes Chapa sent; re-serialising is only a fallback when they were not kept.
    await this.payments.handleChapaWebhook(req.rawBody ?? JSON.stringify(body ?? {}), headers, body);
    return { received: true };
  }

  @Get('callback')
  @ApiOperation({
    summary: 'Chapa callback',
    description:
      'Chapa calls this when a payment finishes, with `trx_ref`, `ref_id` and `status`. Only `trx_ref` is used, ' +
      'and only to verify that payment with Chapa. The answer is the same whether or not the reference is known.',
  })
  @ApiOkResponse({ type: WebhookAckDto })
  async callback(
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<WebhookAckDto> {
    await this.payments.handleChapaCallback(query.trx_ref ?? query.tx_ref ?? body?.trx_ref ?? body?.tx_ref);
    return { received: true };
  }
}
