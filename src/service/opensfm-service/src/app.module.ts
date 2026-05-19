import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OpenSfmModule } from './opensfm/opensfm.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), OpenSfmModule],
})
export class AppModule {}
