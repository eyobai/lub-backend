import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { AppException, ErrorCode } from '../errors/app.exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
  const req = { id: 'req-1', url: '/api/v1/things?x=1', originalUrl: '/api/v1/things?x=1' };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter();
  const logger = { error: jest.fn(), warn: jest.fn() };
  Object.assign(filter, { logger });
  filter.catch(exception, host);
  const body = res.json.mock.calls[0][0] as Record<string, unknown>;
  return { res, body, logger };
}

describe('AllExceptionsFilter', () => {
  it('passes an application error through with its code and details', () => {
    const { res, body } = run(new AppException(409, ErrorCode.DUPLICATE_BID, 'Already bid', { amountsMinor: ['100'] }));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'DUPLICATE_BID',
      message: 'Already bid',
      details: { amountsMinor: ['100'] },
      path: '/api/v1/things',
      requestId: 'req-1',
    });
  });

  it('lists the invalid fields of a validation error', () => {
    const { body } = run(new BadRequestException(['phoneNumber must be a string']));
    expect(body).toMatchObject({
      statusCode: 400,
      error: 'VALIDATION_FAILED',
      details: { fields: [expect.any(String)] },
    });
  });

  it('hides the details of an unexpected error and logs it', () => {
    const { res, body, logger } = run(new Error('relation "users" does not exist'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(body).toMatchObject({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(JSON.stringify(body)).not.toContain('users');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('answers 413 for a body the parser refused as too large', () => {
    const { res, body } = run(Object.assign(new Error('request entity too large'), { status: 413, expose: true }));
    expect(res.status).toHaveBeenCalledWith(413);
    expect(body).toMatchObject({ error: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' });
  });

  it('does not trust a status on an error that is not marked as safe to expose', () => {
    const { res } = run(Object.assign(new Error('boom'), { status: 400 }));
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it.each(['P2024', 'P2028'])('answers 503 with Retry-After when the database is overloaded (%s)', (code) => {
    const { res, body, logger } = run(Object.assign(new Error('Timed out fetching a new connection'), { code }));
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '2');
    expect(body).toMatchObject({ statusCode: 503, error: 'SERVICE_BUSY' });
    expect(JSON.stringify(body)).not.toContain('connection');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
