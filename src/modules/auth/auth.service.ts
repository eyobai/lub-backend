import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { OtpPurpose, Prisma, RoleName, SecurityEventType } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ClientInfo } from '../../common/decorators/client-info.decorator';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OtpIssueResult, OtpService } from '../otp/otp.service';
import { PhoneService } from '../phone/phone.service';
import {
  ChangePasswordDto,
  LoginDto,
  PhoneOnlyDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyPhoneDto,
} from './dto/auth-request.dto';
import {
  AuthResponseDto,
  AuthUserDto,
  MessageResponseDto,
  OtpRequestedResponseDto,
  RegisterResponseDto,
} from './dto/auth-response.dto';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password.service';
import { SecurityEventService } from './security-event.service';
import { RevokeReason, TokenService } from './token.service';

const userWithRelations = { profile: true, roles: { include: { role: true } } } satisfies Prisma.UserInclude;
type UserWithRelations = Prisma.UserGetPayload<{ include: typeof userWithRelations }>;

const OTP_REQUESTED_MESSAGE = 'If the phone number is eligible, a verification code has been sent.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly phones: PhoneService,
    private readonly passwords: PasswordService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly loginAttempts: LoginAttemptService,
    private readonly securityEvents: SecurityEventService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async register(dto: RegisterDto, client: ClientInfo): Promise<RegisterResponseDto> {
    const phoneNumber = this.phones.normalize(dto.phoneNumber);
    const email = dto.email?.toLowerCase();
    const passwordHash = await this.passwords.hash(dto.password);

    if (!this.verificationRequired) return this.registerWithoutVerification(dto, phoneNumber, passwordHash, client);

    const existing = await this.prisma.user.findUnique({ where: { phoneNumber } });
    if (existing?.phoneVerifiedAt) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.PHONE_ALREADY_REGISTERED,
        'An account with this phone number already exists',
      );
    }

    // Checked before any write so a rate-limited request cannot replace a pending registration.
    await this.otp.assertCanIssue(phoneNumber, OtpPurpose.PHONE_VERIFICATION);

    let userId: string;
    try {
      userId = await this.prisma.$transaction(async (tx) => {
        const profile = { fullName: dto.fullName ?? null, email: email ?? null };
        if (existing) {
          // Nobody has proven ownership of this number yet, so the newest registration wins.
          await tx.user.update({
            where: { id: existing.id },
            data: { passwordHash, profile: { upsert: { create: profile, update: profile } } },
          });
          return existing.id;
        }
        const role = await tx.role.findUniqueOrThrow({ where: { name: RoleName.USER } });
        const user = await tx.user.create({
          data: { phoneNumber, passwordHash, profile: { create: profile }, roles: { create: { roleId: role.id } } },
        });
        return user.id;
      });
    } catch (err) {
      throw this.mapDuplicate(err);
    }

    const otp = await this.otp.issue(phoneNumber, OtpPurpose.PHONE_VERIFICATION, client.ipAddress);
    return {
      userId,
      phoneNumber,
      verificationRequired: true,
      verificationToken: this.verificationToken(userId, passwordHash),
      otp,
    };
  }

  /** Phone verification switched off: the first registration owns the number and is signed in at once. */
  private async registerWithoutVerification(
    dto: RegisterDto,
    phoneNumber: string,
    passwordHash: string,
    client: ClientInfo,
  ): Promise<RegisterResponseDto> {
    const alreadyRegistered = () =>
      new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.PHONE_ALREADY_REGISTERED,
        'An account with this phone number already exists',
      );
    if (await this.prisma.user.findUnique({ where: { phoneNumber }, select: { id: true } })) throw alreadyRegistered();

    try {
      const { user, tokens } = await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.findUniqueOrThrow({ where: { name: RoleName.USER } });
        const user = await tx.user.create({
          data: {
            phoneNumber,
            passwordHash,
            lastLoginAt: new Date(),
            profile: { create: { fullName: dto.fullName ?? null, email: dto.email?.toLowerCase() ?? null } },
            roles: { create: { roleId: role.id } },
          },
          include: userWithRelations,
        });
        const tokens = await this.tokens.issueSession({ id: user.id, roles: this.roleNames(user) }, client, tx);
        return { user, tokens };
      });
      return { userId: user.id, phoneNumber, verificationRequired: false, user: this.toAuthUser(user), tokens };
    } catch (err) {
      throw this.mapDuplicate(err);
    }
  }

  /** Translates unique-constraint violations on phone number / email into 409 responses. */
  private mapDuplicate(err: unknown): unknown {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return err;
    const target = JSON.stringify(err.meta?.target ?? '');
    return target.includes('email')
      ? new AppException(HttpStatus.CONFLICT, ErrorCode.EMAIL_ALREADY_IN_USE, 'This email address is already in use')
      : new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.PHONE_ALREADY_REGISTERED,
          'An account with this phone number already exists',
        );
  }

  private get verificationRequired(): boolean {
    return this.config.phone.verificationRequired;
  }

  /** SMS-based flows (phone verification, password reset by code) only exist while verification is on. */
  private assertSmsFlowsEnabled(): void {
    if (this.verificationRequired) return;
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.SMS_VERIFICATION_DISABLED,
      'Verification by SMS is not available. To reset a password, contact support.',
    );
  }

  async verifyPhone(dto: VerifyPhoneDto, client: ClientInfo): Promise<AuthResponseDto> {
    this.assertSmsFlowsEnabled();
    const phoneNumber = this.phones.normalize(dto.phoneNumber);
    const user = await this.prisma.user.findUnique({ where: { phoneNumber }, include: userWithRelations });
    if (!user) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.OTP_INVALID,
        'The verification code is invalid or has expired',
      );
    }
    if (user.phoneVerifiedAt) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.PHONE_ALREADY_VERIFIED,
        'This phone number is already verified',
      );
    }
    this.assertActive(user);
    if (!this.verificationTokenMatches(dto.verificationToken, user.id, user.passwordHash)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.REGISTRATION_SUPERSEDED,
        'This registration is no longer valid. Please register again.',
      );
    }

    const now = new Date();
    try {
      const tokens = await this.prisma.$transaction(async (tx) => {
        await this.otp.verifyAndConsume(phoneNumber, OtpPurpose.PHONE_VERIFICATION, dto.code, tx);
        await tx.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: now, lastLoginAt: now } });
        return this.tokens.issueSession({ id: user.id, roles: this.roleNames(user) }, client, tx);
      });
      return { user: this.toAuthUser({ ...user, phoneVerifiedAt: now }), tokens };
    } catch (err) {
      if (err instanceof AppException && err.code === ErrorCode.OTP_INVALID) {
        await this.securityEvents.record(SecurityEventType.OTP_VERIFICATION_FAILED, {
          userId: user.id,
          phoneNumber,
          client,
          metadata: { purpose: OtpPurpose.PHONE_VERIFICATION },
        });
      }
      throw err;
    }
  }

  /** Re-sends the phone verification code. The response never reveals whether the number is registered. */
  async resendVerification(dto: PhoneOnlyDto, client: ClientInfo): Promise<OtpRequestedResponseDto> {
    this.assertSmsFlowsEnabled();
    const phoneNumber = this.phones.normalize(dto.phoneNumber);
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });
    const eligible = !!user && !user.phoneVerifiedAt && user.status === 'ACTIVE';
    return this.requestOtpQuietly(eligible, phoneNumber, OtpPurpose.PHONE_VERIFICATION, client);
  }

  async login(dto: LoginDto, client: ClientInfo): Promise<AuthResponseDto> {
    const phoneNumber = this.phones.normalize(dto.phoneNumber);

    const lockedFor = await this.loginAttempts.lockedForSeconds(phoneNumber);
    if (lockedFor > 0) throw this.lockedError(lockedFor);

    const user = await this.prisma.user.findUnique({ where: { phoneNumber }, include: userWithRelations });
    const passwordOk = await this.passwords.verify(user?.passwordHash, dto.password);

    if (!user || !passwordOk) {
      const locked = await this.loginAttempts.recordFailure(phoneNumber);
      await this.securityEvents.record(SecurityEventType.LOGIN_FAILED, { userId: user?.id, phoneNumber, client });
      if (locked) {
        await this.securityEvents.record(SecurityEventType.ACCOUNT_LOCKED, { userId: user?.id, phoneNumber, client });
        throw this.lockedError(this.config.login.lockoutSeconds);
      }
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        'Incorrect phone number or password',
      );
    }

    await this.loginAttempts.reset(phoneNumber);
    if (this.verificationRequired && !user.phoneVerifiedAt) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PHONE_NOT_VERIFIED,
        'Verify your phone number before signing in',
        { verificationToken: this.verificationToken(user.id, user.passwordHash) },
      );
    }
    this.assertActive(user);

    const tokens = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      return this.tokens.issueSession({ id: user.id, roles: this.roleNames(user) }, client, tx);
    });
    await this.securityEvents.record(SecurityEventType.LOGIN_SUCCESS, { userId: user.id, phoneNumber, client });
    return { user: this.toAuthUser(user), tokens };
  }

  refresh(refreshToken: string, client: ClientInfo) {
    return this.tokens.rotate(refreshToken, client);
  }

  logout(refreshToken: string): Promise<void> {
    return this.tokens.revokeByRefreshToken(refreshToken);
  }

  logoutAll(userId: string): Promise<void> {
    return this.tokens.revokeAllForUser(userId, RevokeReason.LOGOUT_ALL);
  }

  /** Starts a password reset. The response never reveals whether the number is registered. */
  async forgotPassword(dto: PhoneOnlyDto, client: ClientInfo): Promise<OtpRequestedResponseDto> {
    this.assertSmsFlowsEnabled();
    const phoneNumber = this.phones.normalize(dto.phoneNumber);
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });
    const eligible = !!user && !!user.phoneVerifiedAt && user.status !== 'BLOCKED';
    return this.requestOtpQuietly(eligible, phoneNumber, OtpPurpose.PASSWORD_RESET, client);
  }

  async resetPassword(dto: ResetPasswordDto, client: ClientInfo): Promise<MessageResponseDto> {
    this.assertSmsFlowsEnabled();
    const phoneNumber = this.phones.normalize(dto.phoneNumber);
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });
    if (!user || !user.phoneVerifiedAt || user.status === 'BLOCKED') {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.OTP_INVALID,
        'The verification code is invalid or has expired',
      );
    }
    const passwordHash = await this.passwords.hash(dto.newPassword);

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.otp.verifyAndConsume(phoneNumber, OtpPurpose.PASSWORD_RESET, dto.code, tx);
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false },
        });
        await this.tokens.revokeAllForUser(user.id, RevokeReason.PASSWORD_RESET, tx);
      });
    } catch (err) {
      if (err instanceof AppException && err.code === ErrorCode.OTP_INVALID) {
        await this.securityEvents.record(SecurityEventType.OTP_VERIFICATION_FAILED, {
          userId: user.id,
          phoneNumber,
          client,
          metadata: { purpose: OtpPurpose.PASSWORD_RESET },
        });
      }
      throw err;
    }

    await this.loginAttempts.reset(phoneNumber);
    await this.securityEvents.record(SecurityEventType.PASSWORD_RESET, { userId: user.id, phoneNumber, client });
    return { message: 'Password has been reset. Please sign in with your new password.' };
  }

  /** Changes the password, signs out every existing session and returns tokens for a fresh one. */
  async changePassword(userId: string, dto: ChangePasswordDto, client: ClientInfo): Promise<AuthResponseDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: userWithRelations });
    if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      throw new AppException(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.PASSWORD_REUSED,
        'New password must be different from the current password',
      );
    }
    const passwordHash = await this.passwords.hash(dto.newPassword);

    const tokens = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false },
      });
      await this.tokens.revokeAllForUser(userId, RevokeReason.PASSWORD_CHANGED, tx);
      return this.tokens.issueSession({ id: userId, roles: this.roleNames(user) }, client, tx);
    });
    await this.securityEvents.record(SecurityEventType.PASSWORD_CHANGED, {
      userId,
      phoneNumber: user.phoneNumber,
      client,
    });
    return { user: { ...this.toAuthUser(user), mustChangePassword: false }, tokens };
  }

  async me(userId: string): Promise<AuthUserDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: userWithRelations });
    return this.toAuthUser(user);
  }

  /** Issues an OTP when eligible but returns the same response either way (no account enumeration). */
  private async requestOtpQuietly(
    eligible: boolean,
    phoneNumber: string,
    purpose: OtpPurpose,
    client: ClientInfo,
  ): Promise<OtpRequestedResponseDto> {
    const fallback: OtpIssueResult = {
      expiresInSeconds: this.config.otp.ttlSeconds,
      resendAvailableInSeconds: this.config.otp.resendCooldownSeconds,
    };
    if (eligible) {
      try {
        await this.otp.issue(phoneNumber, purpose, client.ipAddress);
      } catch (err) {
        if (!(err instanceof AppException)) throw err;
        this.logger.warn({ code: err.code, purpose }, 'OTP request not fulfilled');
      }
    }
    return { message: OTP_REQUESTED_MESSAGE, otp: fallback };
  }

  /**
   * Binds phone verification to the password chosen in a specific registration. Without it, someone
   * could re-register a pending number with their own password and wait for the real owner to
   * enter the SMS code, ending up with a verified account they can sign in to.
   */
  private verificationToken(userId: string, passwordHash: string): string {
    return createHmac('sha256', this.config.otp.hmacSecret)
      .update(`registration:${userId}:${passwordHash}`)
      .digest('base64url');
  }

  private verificationTokenMatches(token: string, userId: string, passwordHash: string): boolean {
    const expected = Buffer.from(this.verificationToken(userId, passwordHash));
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private assertActive(user: { status: string }): void {
    if (user.status === 'ACTIVE') return;
    throw user.status === 'BLOCKED'
      ? new AppException(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_BLOCKED, 'This account has been blocked')
      : new AppException(HttpStatus.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended');
  }

  private lockedError(retryAfterSeconds: number): AppException {
    return new AppException(
      HttpStatus.TOO_MANY_REQUESTS,
      ErrorCode.ACCOUNT_LOCKED,
      'Too many failed sign-in attempts. Please try again later.',
      { retryAfterSeconds },
    );
  }

  private roleNames(user: UserWithRelations): RoleName[] {
    return user.roles.map((r) => r.role.name);
  }

  private toAuthUser(user: UserWithRelations): AuthUserDto {
    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      phoneVerified: !!user.phoneVerifiedAt,
      status: user.status,
      roles: this.roleNames(user),
      mustChangePassword: user.mustChangePassword,
      fullName: user.profile?.fullName ?? null,
      email: user.profile?.email ?? null,
      createdAt: user.createdAt,
    };
  }
}
