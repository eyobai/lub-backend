import { OtpPurpose } from '@prisma/client';

export interface OtpMessage {
  phoneNumber: string;
  code: string;
  purpose: OtpPurpose;
  expiresInSeconds: number;
}

/**
 * Delivery channel for one-time passwords. Implement this interface for each SMS provider
 * and register it in `otp-sender.registry.ts`; authentication logic never changes.
 */
export interface OtpSender {
  readonly name: string;
  send(message: OtpMessage): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');
