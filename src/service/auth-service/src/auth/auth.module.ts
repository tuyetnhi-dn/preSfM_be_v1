import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController, AdminController],
  providers: [AuthService, TokenService, AdminService],
  exports: [AuthService],
})
export class AuthModule {}
