import { Logger } from '@nestjs/common';
import { OtpMessage, OtpSender } from './otp-sender.interface';

/**
 * DEVELOPMENT ONLY: writes the OTP to the application log instead of sending an SMS.
 * Guarded twice: env validation rejects OTP_PROVIDER=console in production, and this
 * constructor throws if it is ever instantiated there.
 */
export class ConsoleOtpSender implements OtpSender {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleOtpSender.name);

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error('ConsoleOtpSender must never be used in production');
    }
  }

  send(message: OtpMessage): Promise<void> {
    this.logger.warn(
      `[DEV OTP] ${message.purpose} code for ${message.phoneNumber}: ${message.code} (expires in ${message.expiresInSeconds}s)`,
    );
    return Promise.resolve();
  }
}
