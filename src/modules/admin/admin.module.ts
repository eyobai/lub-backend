import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminAuditService } from './admin-audit.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminInsightController } from './admin-insight.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController, AdminInsightController],
  providers: [AdminUsersService, AdminAuditService, AdminDashboardService],
})
export class AdminModule {}
