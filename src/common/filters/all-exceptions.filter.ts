import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppException, ErrorCode } from '../errors/app.exception';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

/** Errors in the http-errors convention (body-parser and other Express middleware) that blame the client. */
function isClientError(exception: unknown): exception is Error & { status: number } {
  const { status, expose } = (exception ?? {}) as { status?: unknown; expose?: unknown };
  return exception instanceof Error && expose === true && typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * The database could not serve the request in time: no free connection (P2024) or a transaction that waited
 * too long (P2028). Nothing was committed, so the client may simply try again.
 */
function isOverload(exception: unknown): boolean {
  const code = (exception as { code?: unknown } | null)?.code;
  return exception instanceof Error && (code === 'P2024' || code === 'P2028');
}

/** Converts every thrown error into the documented ErrorResponseDto shape and never leaks internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error: string = ErrorCode.INTERNAL_ERROR;
    let message = 'An unexpected error occurred';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppException) {
      status = exception.getStatus();
      error = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      error = ErrorCode.RATE_LIMITED;
      message = 'Too many requests. Please try again later.';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      error = STATUS_CODES[status] ?? `HTTP_${status}`;
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const raw = (body as { message?: string | string[] }).message;
        if (Array.isArray(raw)) {
          message = 'Request validation failed';
          details = { fields: raw };
        } else {
          message = raw ?? exception.message;
        }
      }
    } else if (isClientError(exception)) {
      // Raised before any controller runs, e.g. by the body parser for an oversized or broken body.
      status = exception.status;
      const tooLarge = exception.status === Number(HttpStatus.PAYLOAD_TOO_LARGE);
      error = tooLarge ? ErrorCode.PAYLOAD_TOO_LARGE : (STATUS_CODES[status] ?? `HTTP_${status}`);
      message = tooLarge ? 'The request body is too large' : 'The request could not be read';
    } else if (isOverload(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      error = ErrorCode.SERVICE_BUSY;
      message = 'The service is busy. Please try again in a moment.';
      res.setHeader('Retry-After', '2');
      this.logger.warn({ requestId: req.id, path: req.url }, `Database overloaded: ${(exception as Error).message}`);
    } else {
      this.logger.error(
        { err: exception, requestId: req.id, path: req.url },
        exception instanceof Error ? exception.message : 'Unhandled exception',
      );
    }

    res.status(status).json({
      statusCode: status,
      error,
      message,
      ...(details ? { details } : {}),
      path: req.originalUrl?.split('?')[0],
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  }
}
