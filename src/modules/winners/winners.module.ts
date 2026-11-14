import { Module } from '@nestjs/common';
import { ResultsModule } from '../results/results.module';
import { AdminWinnersController } from './admin-winners.controller';
import { WinnersController } from './winners.controller';
import { WinnersService } from './winners.service';

@Module({
  imports: [ResultsModule],
  controllers: [WinnersController, AdminWinnersController],
  providers: [WinnersService],
  exports: [WinnersService],
})
export class WinnersModule {}
