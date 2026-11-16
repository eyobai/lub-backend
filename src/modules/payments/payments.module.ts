import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BiddingModule } from '../bidding/bidding.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminDepositsController } from './admin-deposits.controller';
import { ChapaClient } from './chapa.client';
import { ChapaHooksController } from './chapa-hooks.controller';
import { DepositsController } from './deposits.controller';
import { PAYMENTS_QUEUE, PaymentsProcessor } from './payments.processor';
import { PaymentsService } from './payments.service';

@Module({
  imports: [BullModule.registerQueue({ name: PAYMENTS_QUEUE }), LedgerModule, WalletModule, BiddingModule],
  controllers: [DepositsController, ChapaHooksController, AdminDepositsController],
  providers: [PaymentsService, PaymentsProcessor, ChapaClient],
  exports: [PaymentsService],
})
export class PaymentsModule {}
