import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface ClientInfo {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export const Client = createParamDecorator((_data: unknown, ctx: ExecutionContext): ClientInfo => {
  const req = ctx.switchToHttp().getRequest<Request & { id?: string }>();
  return {
    ipAddress: req.ip?.slice(0, 64),
    userAgent: req.get('user-agent')?.slice(0, 512),
    requestId: req.id ? String(req.id).slice(0, 64) : undefined,
  };
});
