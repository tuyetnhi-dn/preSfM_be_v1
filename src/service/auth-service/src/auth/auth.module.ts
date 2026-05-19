import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [AuthService, TokenService],
})
export class AuthModule {}
