import { createParamDecorator, ExecutionContext, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { AppException, ErrorCode } from '../errors/app.exception';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Reads the mandatory `Idempotency-Key` header. Clients generate one key (e.g. a UUID) per intended
 * operation and resend it on retries, so a retried request cannot be applied twice.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest<Request>().get(IDEMPOTENCY_KEY_HEADER);
  if (!value || !PATTERN.test(value)) {
    throw new AppException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      `Send an ${IDEMPOTENCY_KEY_HEADER} header of 8-128 characters (letters, digits, "_", ".", ":" or "-")`,
    );
  }
  return value;
});
