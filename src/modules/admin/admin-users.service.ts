import { HttpStatus, Injectable } from '@nestjs/common';
import { AccountStatus, ActorType, Prisma, RoleName, SecurityEventType } from '@prisma/client';
import { randomInt } from 'node:crypto';
import type { ClientInfo } from '../../common/decorators/client-info.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { paging } from '../../common/dto/page-query.dto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { STAFF_ROLES } from '../../common/roles';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LoginAttemptService } from '../auth/login-attempt.service';
import { PasswordService } from '../auth/password.service';
import { SecurityEventService } from '../auth/security-event.service';
import { RevokeReason, TokenService } from '../auth/token.service';
import { passwordResetByStaff } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AdminListUsersQueryDto,
  AdminUserDetailDto,
  AdminUserDto,
  AdminUserPageDto,
  PasswordResetResultDto,
  SessionsRevokedDto,
} from './dto/admin-user.dto';
import { manageRefusal, normalizeStaffRoles, temporaryPassword } from './user-rules';

type Tx = Prisma.TransactionClient;

const userInclude = { profile: true, roles: { include: { role: true } } } satisfies Prisma.UserInclude;
type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

const notFound = () => new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'User not found');
const roleNames = (user: UserRow): RoleName[] => user.roles.map((r) => r.role.name);

const STATUS_ACTIONS: Record<AccountStatus, string> = {
  [AccountStatus.SUSPENDED]: 'user.suspend',
  [AccountStatus.BLOCKED]: 'user.block',
  [AccountStatus.ACTIVE]: 'user.reactivate',
};

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly loginAttempts: LoginAttemptService,
    private readonly securityEvents: SecurityEventService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(query: AdminListUsersQueryDto): Promise<AdminUserPageDto> {
    const { page, limit, skip } = paging(query);
    const where: Prisma.UserWhereInput = {
      status: query.status,
      roles: query.role ? { some: { role: { name: query.role } } } : undefined,
      OR: query.search ? this.searchFilter(query.search) : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map((row) => this.toDto(row)), total, page, limit };
  }

  async get(id: string): Promise<AdminUserDetailDto> {
    const user = await this.prisma.user.findUnique({ where: { id }, include: userInclude });
    if (!user) throw notFound();
    return this.toDetail(this.prisma, user);
  }

  /** Suspends, blocks or reactivates an account. Leaving ACTIVE signs the user out everywhere at once. */
  setStatus(
    actor: AuthenticatedUser,
    id: string,
    status: AccountStatus,
    reason: string,
    client: ClientInfo,
  ): Promise<AdminUserDetailDto> {
    return this.manage(actor, id, async (tx, user) => {
      if (user.status === status) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.ACCOUNT_INVALID_STATE,
          `The account is already ${status}`,
        );
      }
      const statusReason = status === AccountStatus.ACTIVE ? null : reason;
      const updated = await tx.user.update({ where: { id }, data: { status, statusReason }, include: userInclude });
      if (status !== AccountStatus.ACTIVE) await this.tokens.revokeAllForUser(id, RevokeReason.ACCOUNT_STATUS, tx);

      await this.audit.record(tx, {
        actorId: actor.id,
        actorType: ActorType.ADMIN,
        action: STATUS_ACTIONS[status],
        entityType: 'user',
        entityId: id,
        before: { status: user.status, statusReason: user.statusReason },
        after: { status, statusReason },
        metadata: { reason },
        client,
      });
      return this.toDetail(tx, updated);
    });
  }

  /**
   * Replaces the account's back-office roles with `roles`. The USER role is left as it is.
   * The route is SUPER_ADMIN only; the actor's roles are checked again inside the transaction.
   */
  setRoles(
    actor: AuthenticatedUser,
    id: string,
    roles: RoleName[],
    reason: string,
    client: ClientInfo,
  ): Promise<AdminUserDetailDto> {
    return this.manage(
      actor,
      id,
      async (tx, user) => {
        const before = roleNames(user);
        const wanted = normalizeStaffRoles(roles);
        const current = normalizeStaffRoles(before);
        const granted = wanted.filter((role) => !current.includes(role));
        const removed = current.filter((role) => !wanted.includes(role));
        if (granted.length === 0 && removed.length === 0) return this.toDetail(tx, user);

        const roleRows = await tx.role.findMany({ where: { name: { in: [...granted, ...removed] } } });
        const roleId = (name: RoleName) => roleRows.find((row) => row.name === name)!.id;
        if (removed.length > 0) {
          await tx.userRole.deleteMany({ where: { userId: id, roleId: { in: removed.map(roleId) } } });
        }
        if (granted.length > 0) {
          await tx.userRole.createMany({
            data: granted.map((name) => ({ userId: id, roleId: roleId(name), grantedById: actor.id })),
          });
        }
        // Roles are read on every request, but a signed-in device should not silently change powers.
        await this.tokens.revokeAllForUser(id, RevokeReason.REVOKED_BY_STAFF, tx);

        const updated = await tx.user.findUniqueOrThrow({ where: { id }, include: userInclude });
        await this.audit.record(tx, {
          actorId: actor.id,
          actorType: ActorType.ADMIN,
          action: 'user.roles.set',
          entityType: 'user',
          entityId: id,
          before: { roles: before },
          after: { roles: roleNames(updated) },
          metadata: { reason, granted, removed },
          client,
        });
        return this.toDetail(tx, updated);
      },
      { superAdminOnly: true },
    );
  }

  /**
   * Sets a random temporary password and returns it once. It is stored only as a hash and never
   * logged or audited. The user is signed out everywhere and must replace it at the next sign-in.
   */
  async resetPassword(
    actor: AuthenticatedUser,
    id: string,
    reason: string,
    client: ClientInfo,
  ): Promise<PasswordResetResultDto> {
    const password = temporaryPassword(randomInt);
    const passwordHash = await this.passwords.hash(password);

    const user = await this.manage(actor, id, async (tx, target) => {
      const updated = await tx.user.update({
        where: { id },
        data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: true },
        include: userInclude,
      });
      await this.tokens.revokeAllForUser(id, RevokeReason.PASSWORD_RESET, tx);
      await this.audit.record(tx, {
        actorId: actor.id,
        actorType: ActorType.ADMIN,
        action: 'user.password.reset',
        entityType: 'user',
        entityId: id,
        before: { mustChangePassword: target.mustChangePassword },
        after: { mustChangePassword: true },
        metadata: { reason },
        client,
      });
      await this.notifications.notify(tx, id, passwordResetByStaff());
      return this.toDetail(tx, updated);
    });

    // The old password may have locked sign-in; the new one must work straight away.
    await this.loginAttempts.reset(user.phoneNumber);
    await this.securityEvents.record(SecurityEventType.PASSWORD_RESET, {
      userId: id,
      phoneNumber: user.phoneNumber,
      client,
      metadata: { byStaff: true, actorId: actor.id },
    });
    return { temporaryPassword: password, user };
  }

  /** Signs the account out of every device, e.g. after a lost phone. */
  revokeSessions(
    actor: AuthenticatedUser,
    id: string,
    reason: string,
    client: ClientInfo,
  ): Promise<SessionsRevokedDto> {
    return this.manage(actor, id, async (tx) => {
      const revoked = await this.activeSessions(tx, id);
      await this.tokens.revokeAllForUser(id, RevokeReason.REVOKED_BY_STAFF, tx);
      await this.audit.record(tx, {
        actorId: actor.id,
        actorType: ActorType.ADMIN,
        action: 'user.sessions.revoke',
        entityType: 'user',
        entityId: id,
        metadata: { reason, revoked },
        client,
      });
      return { revoked };
    });
  }

  /**
   * Runs one change to an account. Changes are serialized (one at a time across the platform), so the
   * "who may manage whom" and "last SUPER_ADMIN" checks cannot be defeated by two requests racing.
   * The actor's roles are read again here rather than trusted from the request.
   *
   * Together these keep at least one active SUPER_ADMIN: a staff account can only be changed by a
   * different, active SUPER_ADMIN, who is still one afterwards.
   */
  private manage<T>(
    actor: AuthenticatedUser,
    id: string,
    change: (tx: Tx, target: UserRow) => Promise<T>,
    options: { superAdminOnly?: boolean } = {},
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('user-management'))`;
      const [actorRow, target] = await Promise.all([
        tx.user.findUnique({ where: { id: actor.id }, include: userInclude }),
        tx.user.findUnique({ where: { id }, include: userInclude }),
      ]);
      const forbidden = (message: string) => new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
      if (!actorRow || actorRow.status !== AccountStatus.ACTIVE) throw forbidden('Your account is not active');
      const actorRoles = roleNames(actorRow);
      if (options.superAdminOnly && !actorRoles.includes(RoleName.SUPER_ADMIN)) {
        throw forbidden('Only a SUPER_ADMIN can change roles');
      }
      if (!target) throw notFound();

      const refusal = manageRefusal({ id: actor.id, roles: actorRoles }, { id, roles: roleNames(target) });
      if (refusal) throw forbidden(refusal);
      return change(tx, target);
    });
  }

  private searchFilter(search: string): Prisma.UserWhereInput[] {
    const filters: Prisma.UserWhereInput[] = [
      { profile: { fullName: { contains: search, mode: 'insensitive' } } },
      { profile: { email: { contains: search, mode: 'insensitive' } } },
    ];
    // Stored as +2519…; people type 09…, 9… or +2519…, so match on the digits without a leading zero.
    if (/^\+?[0-9 ()-]+$/.test(search)) {
      const digits = search.replace(/\D/g, '').replace(/^0+/, '');
      if (digits.length >= 2) filters.push({ phoneNumber: { contains: digits } });
    }
    return filters;
  }

  private activeSessions(db: Tx, userId: string): Promise<number> {
    return db.refreshToken
      .findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        distinct: ['familyId'],
        select: { familyId: true },
      })
      .then((rows) => rows.length);
  }

  private async toDetail(db: Tx, user: UserRow): Promise<AdminUserDetailDto> {
    const [activeSessions, bidCount, winCount] = await Promise.all([
      this.activeSessions(db, user.id),
      db.bid.count({ where: { userId: user.id } }),
      db.winner.count({ where: { userId: user.id } }),
    ]);
    return { ...this.toDto(user), passwordChangedAt: user.passwordChangedAt, activeSessions, bidCount, winCount };
  }

  private toDto(user: UserRow): AdminUserDto {
    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      fullName: user.profile?.fullName ?? null,
      email: user.profile?.email ?? null,
      status: user.status,
      statusReason: user.statusReason,
      roles: [RoleName.USER, ...STAFF_ROLES].filter((role) => roleNames(user).includes(role)),
      phoneVerified: !!user.phoneVerifiedAt,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }
}
