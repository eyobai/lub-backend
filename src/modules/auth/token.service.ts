import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RoleName, SecurityEventType } from '@prisma/client';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { ClientInfo } from '../../common/decorators/client-info.decorator';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { SecurityEventService } from './security-event.service';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  roles: RoleName[];
  typ: 'access';
  iat: number;
  exp: number;
}

interface RefreshTokenPayload {
  sub: string;
  sid: string;
  jti: string;
  typ: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  /** Refresh-token lifetime in seconds. */
  refreshExpiresIn: number;
}

export enum RevokeReason {
  ROTATED = 'ROTATED',
  LOGOUT = 'LOGOUT',
  LOGOUT_ALL = 'LOGOUT_ALL',
  REUSE_DETECTED = 'REUSE_DETECTED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  ACCOUNT_STATUS = 'ACCOUNT_STATUS',
}

const JWT_ALGORITHM = 'HS256';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get refreshTtlSeconds(): number {
    return this.config.jwt.refreshTtlDays * 86_400;
  }

  /** Starts a new login session (refresh-token family). */
  async issueSession(
    user: { id: string; roles: RoleName[] },
    client: ClientInfo,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<TokenPair> {
    return this.issue(user, randomUUID(), client, tx);
  }

  /**
   * Exchanges a refresh token for a new pair and revokes the old one. Presenting an
   * already-used token is treated as theft: the whole session is revoked.
   */
  async rotate(refreshToken: string, client: ClientInfo): Promise<TokenPair> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const invalid = () =>
      new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_REFRESH_TOKEN, 'Refresh token is invalid or expired');
    if (!payload) throw invalid();

    const stored = await this.prisma.refreshToken.findUnique({
      where: { id: payload.jti },
      include: { user: { include: { roles: { include: { role: true } } } } },
    });
    if (!stored || stored.tokenHash !== this.hashToken(refreshToken) || stored.userId !== payload.sub) throw invalid();

    if (stored.revokedAt) {
      if (stored.revokedReason === RevokeReason.ROTATED) {
        await this.revokeSession(stored.familyId, RevokeReason.REUSE_DETECTED);
        await this.securityEvents.record(SecurityEventType.REFRESH_TOKEN_REUSE, {
          userId: stored.userId,
          client,
          metadata: { sessionId: stored.familyId },
        });
      }
      throw invalid();
    }
    if (stored.expiresAt <= new Date()) throw invalid();

    if (stored.user.status !== 'ACTIVE') {
      await this.revokeSession(stored.familyId, RevokeReason.ACCOUNT_STATUS);
      throw new AppException(
        HttpStatus.FORBIDDEN,
        stored.user.status === 'BLOCKED' ? ErrorCode.ACCOUNT_BLOCKED : ErrorCode.ACCOUNT_SUSPENDED,
        'This account is not active',
      );
    }

    const roles = stored.user.roles.map((r) => r.role.name);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Compare-and-swap: only one concurrent caller can rotate a given token.
        const claimed = await tx.refreshToken.updateMany({
          where: { id: stored.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: RevokeReason.ROTATED },
        });
        if (claimed.count !== 1) throw invalid();

        const next = await this.issue({ id: stored.userId, roles }, stored.familyId, client, tx);
        const nextId = this.jwt.decode<RefreshTokenPayload>(next.refreshToken).jti;
        await tx.refreshToken.update({ where: { id: stored.id }, data: { replacedById: nextId } });
        return next;
      });
    } catch (err) {
      if (err instanceof AppException) {
        // Lost the race against a parallel refresh of the same token.
        await this.revokeSession(stored.familyId, RevokeReason.REUSE_DETECTED);
      }
      throw err;
    }
  }

  /** Revokes the session a refresh token belongs to. Silently ignores invalid tokens. */
  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    const payload = await this.verifyRefreshToken(refreshToken);
    if (!payload) return;
    const stored = await this.prisma.refreshToken.findUnique({ where: { id: payload.jti } });
    if (!stored || stored.tokenHash !== this.hashToken(refreshToken)) return;
    await this.revokeSession(stored.familyId, RevokeReason.LOGOUT);
  }

  async revokeSession(sessionId: string, reason: RevokeReason): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.denySessions([sessionId]);
  }

  /** Revokes every session of a user (optionally inside the caller's transaction). */
  async revokeAllForUser(
    userId: string,
    reason: RevokeReason,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const active = await tx.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.denySessions(active.map((t) => t.familyId));
  }

  /** True when the session was revoked while its access tokens may still be unexpired. */
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(this.denyKey(sessionId))) === 1;
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    return this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: this.config.jwt.accessSecret,
      issuer: this.config.jwt.issuer,
      algorithms: [JWT_ALGORITHM],
    });
  }

  private async issue(
    user: { id: string; roles: RoleName[] },
    sessionId: string,
    client: ClientInfo,
    tx: Prisma.TransactionClient,
  ): Promise<TokenPair> {
    const { accessSecret, refreshSecret, accessTtlSeconds, issuer } = this.config.jwt;
    const jti = randomUUID();

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { sub: user.id, sid: sessionId, roles: user.roles, typ: 'access' },
        { secret: accessSecret, expiresIn: accessTtlSeconds, issuer, algorithm: JWT_ALGORITHM },
      ),
      this.jwt.signAsync(
        { sub: user.id, sid: sessionId, jti, typ: 'refresh' },
        { secret: refreshSecret, expiresIn: this.refreshTtlSeconds, issuer, algorithm: JWT_ALGORITHM },
      ),
    ]);

    await tx.refreshToken.create({
      data: {
        id: jti,
        userId: user.id,
        familyId: sessionId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
        userAgent: client.userAgent,
        ipAddress: client.ipAddress,
      },
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: accessTtlSeconds,
      refreshExpiresIn: this.refreshTtlSeconds,
    };
  }

  private async verifyRefreshToken(token: string): Promise<RefreshTokenPayload | null> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.jwt.refreshSecret,
        issuer: this.config.jwt.issuer,
        algorithms: [JWT_ALGORITHM],
      });
      return payload.typ === 'refresh' && payload.jti && payload.sid ? payload : null;
    } catch {
      return null;
    }
  }

  private async denySessions(sessionIds: string[]): Promise<void> {
    if (!sessionIds.length) return;
    const pipeline = this.redis.pipeline();
    for (const id of sessionIds) pipeline.set(this.denyKey(id), '1', 'EX', this.config.jwt.accessTtlSeconds);
    await pipeline.exec();
  }

  private denyKey = (sessionId: string) => `auth:session:revoked:${sessionId}`;

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
