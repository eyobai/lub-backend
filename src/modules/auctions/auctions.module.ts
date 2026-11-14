import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BiddingModule } from '../bidding/bidding.module';
import { ResultsModule } from '../results/results.module';
import { AdminAuctionsController } from './admin-auctions.controller';
import { AUCTION_LIFECYCLE_QUEUE, AuctionLifecycleProcessor } from './auction-lifecycle.processor';
import { AuctionLifecycleService } from './auction-lifecycle.service';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';

@Module({
  imports: [BullModule.registerQueue({ name: AUCTION_LIFECYCLE_QUEUE }), BiddingModule, ResultsModule],
  controllers: [AuctionsController, AdminAuctionsController],
  providers: [AuctionsService, AuctionLifecycleService, AuctionLifecycleProcessor],
  exports: [AuctionsService, AuctionLifecycleService],
})
export class AuctionsModule {}
