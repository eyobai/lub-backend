import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from '../decorators/allow-pending-password-change.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { AppException, ErrorCode } from '../errors/app.exception';

/**
 * A password set by staff is known to staff. Until its owner replaces it, the account can only
 * change the password, read its own profile and sign out.
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user?.mustChangePassword) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.PASSWORD_CHANGE_REQUIRED,
      'Choose a new password with POST /auth/change-password before continuing',
    );
  }
}
