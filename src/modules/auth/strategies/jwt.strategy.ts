import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { AppException, ErrorCode } from '../../../common/errors/app.exception';
import { APP_CONFIG } from '../../../config/configuration';
import type { AppConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AccessTokenPayload, TokenService } from '../token.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.jwt.accessSecret,
      issuer: config.jwt.issuer,
      algorithms: ['HS256'],
      ignoreExpiration: false,
    });
  }

  /** Runs on every authenticated request so suspensions, logouts and password changes take effect immediately. */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const unauthorized = () =>
      new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED, 'Access token is invalid or expired');
    if (payload.typ !== 'access' || !payload.sub || !payload.sid) throw unauthorized();

    const [user, revoked] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: { roles: { include: { role: true } } },
      }),
      this.tokens.isSessionRevoked(payload.sid),
    ]);
    if (!user || revoked) throw unauthorized();

    if (user.status !== 'ACTIVE') {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        user.status === 'BLOCKED' ? ErrorCode.ACCOUNT_BLOCKED : ErrorCode.ACCOUNT_SUSPENDED,
        'This account is not active',
      );
    }
    // iat has second precision, so compare against the password change truncated to seconds.
    if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw unauthorized();
    }

    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      roles: user.roles.map((r) => r.role.name),
      sessionId: payload.sid,
    };
  }
}
