import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/configuration';
import { OtpService } from './otp.service';
import { OTP_SENDER } from './senders/otp-sender.interface';
import { createOtpSender } from './senders/otp-sender.registry';

@Module({
  providers: [OtpService, { provide: OTP_SENDER, inject: [APP_CONFIG], useFactory: createOtpSender }],
  exports: [OtpService],
})
export class OtpModule {}
