import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { OtpPurpose, Prisma } from '@prisma/client';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OTP_SENDER } from './senders/otp-sender.interface';
import type { OtpSender } from './senders/otp-sender.interface';

export interface OtpIssueResult {
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  /** Throws 429 when a new code may not be requested yet (resend cooldown or hourly cap). */
  async assertCanIssue(phoneNumber: string, purpose: OtpPurpose): Promise<void> {
    const { resendCooldownSeconds, maxPerHour } = this.config.otp;
    const now = Date.now();

    const recent = await this.prisma.otpVerification.findMany({
      where: { phoneNumber, purpose, createdAt: { gt: new Date(now - 3600_000) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const latest = recent[0];
    if (latest) {
      const waitMs = latest.createdAt.getTime() + resendCooldownSeconds * 1000 - now;
      if (waitMs > 0) {
        const retryAfterSeconds = Math.ceil(waitMs / 1000);
        throw new AppException(
          HttpStatus.TOO_MANY_REQUESTS,
          ErrorCode.OTP_COOLDOWN,
          `Please wait ${retryAfterSeconds} seconds before requesting another code`,
          { retryAfterSeconds },
        );
      }
    }
    if (recent.length >= maxPerHour) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.OTP_LIMIT_REACHED,
        'Too many verification codes requested. Please try again later.',
      );
    }
  }

  /** Creates a new code (invalidating earlier ones) and hands it to the configured sender. */
  async issue(phoneNumber: string, purpose: OtpPurpose, ipAddress?: string): Promise<OtpIssueResult> {
    const { ttlSeconds, resendCooldownSeconds, maxAttempts, length } = this.config.otp;
    const now = Date.now();

    await this.assertCanIssue(phoneNumber, purpose);

    const code = randomInt(0, 10 ** length)
      .toString()
      .padStart(length, '0');

    const otp = await this.prisma.$transaction(async (tx) => {
      await tx.otpVerification.updateMany({
        where: { phoneNumber, purpose, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
      return tx.otpVerification.create({
        data: {
          phoneNumber,
          purpose,
          codeHash: this.hash(phoneNumber, purpose, code),
          maxAttempts,
          expiresAt: new Date(now + ttlSeconds * 1000),
          deliveryProvider: this.sender.name,
          ipAddress,
        },
      });
    });

    try {
      await this.sender.send({ phoneNumber, code, purpose, expiresInSeconds: ttlSeconds });
    } catch (err) {
      this.logger.error({ err, provider: this.sender.name }, 'OTP delivery failed');
      await this.prisma.otpVerification.update({ where: { id: otp.id }, data: { invalidatedAt: new Date() } });
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.OTP_DELIVERY_FAILED,
        'We could not send the verification code. Please try again.',
      );
    }

    return { expiresInSeconds: ttlSeconds, resendAvailableInSeconds: resendCooldownSeconds };
  }

  /**
   * Checks a code and consumes it. The attempt counter is committed outside `tx` so failed
   * guesses are counted even when the caller's transaction rolls back; the consumption itself
   * joins `tx` so it commits atomically with the caller's changes.
   */
  async verifyAndConsume(
    phoneNumber: string,
    purpose: OtpPurpose,
    code: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const invalid = () =>
      new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.OTP_INVALID,
        'The verification code is invalid or has expired',
      );

    const otp = await this.prisma.otpVerification.findFirst({
      where: { phoneNumber, purpose, consumedAt: null, invalidatedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw invalid();

    const counted = await this.prisma.$executeRaw`
      UPDATE "otp_verifications" SET "attempts" = "attempts" + 1
      WHERE "id" = ${otp.id}::uuid AND "attempts" < "max_attempts" AND "consumed_at" IS NULL AND "invalidated_at" IS NULL`;
    if (counted !== 1) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.OTP_ATTEMPTS_EXCEEDED,
        'Too many incorrect attempts. Please request a new verification code.',
      );
    }

    const expected = Buffer.from(otp.codeHash, 'hex');
    const actual = Buffer.from(this.hash(phoneNumber, purpose, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();

    const consumed = await tx.otpVerification.updateMany({
      where: { id: otp.id, consumedAt: null, invalidatedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid();
  }

  private hash(phoneNumber: string, purpose: OtpPurpose, code: string): string {
    return createHmac('sha256', this.config.otp.hmacSecret).update(`${purpose}:${phoneNumber}:${code}`).digest('hex');
  }
}
