import { AppConfig } from '../../../config/configuration';
import { ConsoleOtpSender } from './console-otp.sender';
import { OtpSender } from './otp-sender.interface';

type OtpSenderFactory = (config: AppConfig) => OtpSender;

/** Add real SMS providers here, keyed by the OTP_PROVIDER value that selects them. */
const SENDERS: Record<string, OtpSenderFactory> = {
  // No SMS delivery configured: valid only while PHONE_VERIFICATION_REQUIRED=false.
  none: () => ({
    name: 'none',
    send: () => Promise.reject(new Error('No OTP provider is configured (OTP_PROVIDER=none)')),
  }),
  console: (config) => new ConsoleOtpSender(config.env),
};

export function createOtpSender(config: AppConfig): OtpSender {
  const factory = SENDERS[config.otp.provider];
  if (!factory) {
    throw new Error(
      `Unknown OTP_PROVIDER "${config.otp.provider}". Available providers: ${Object.keys(SENDERS).join(', ')}`,
    );
  }
  return factory(config);
}
