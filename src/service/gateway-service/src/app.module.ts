import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GatewayController } from './gateway/gateway.controller';
import { GatewayService } from './gateway/gateway.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [GatewayController],
  providers: [GatewayService],
})
export class AppModule {}
