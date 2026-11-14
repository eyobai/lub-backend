import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RoleName } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  phoneNumber: string;
  roles: RoleName[];
  /** Login session (refresh-token family) the access token belongs to. */
  sessionId: string;
  /** Staff reset the password: only changing it (and signing out) is allowed until the user picks a new one. */
  mustChangePassword: boolean;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  return ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user;
});
