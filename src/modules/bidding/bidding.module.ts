import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { AdminBidsController } from './admin-bids.controller';
import { BidRefundService } from './bid-refund.service';
import { BiddingService } from './bidding.service';
import { BidsController } from './bids.controller';

@Module({
  imports: [WalletModule],
  controllers: [BidsController, AdminBidsController],
  providers: [BiddingService, BidRefundService],
  exports: [BidRefundService, BiddingService],
})
export class BiddingModule {}
