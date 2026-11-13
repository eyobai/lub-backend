import type { AppConfig } from '../../../config/configuration';
import { ConsoleOtpSender } from './console-otp.sender';
import { createOtpSender } from './otp-sender.registry';

const config = (env: string, provider: string) => ({ env, otp: { provider } }) as unknown as AppConfig;

describe('OTP sender selection', () => {
  it('uses the console sender in development', () => {
    expect(createOtpSender(config('development', 'console'))).toBeInstanceOf(ConsoleOtpSender);
  });

  it('refuses to create the console sender in production even if env validation were bypassed', () => {
    expect(() => createOtpSender(config('production', 'console'))).toThrow(/never be used in production/);
  });

  it('fails fast on an unknown provider instead of silently dropping codes', () => {
    expect(() => createOtpSender(config('production', 'nope'))).toThrow(/Unknown OTP_PROVIDER "nope"/);
  });
});
