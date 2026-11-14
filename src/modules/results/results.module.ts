import { Module } from '@nestjs/common';
import { BiddingModule } from '../bidding/bidding.module';
import { AdminResultsController } from './admin-results.controller';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';

@Module({
  imports: [BiddingModule],
  controllers: [ResultsController, AdminResultsController],
  providers: [ResultsService],
  exports: [ResultsService],
})
export class ResultsModule {}
