import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MaskGenerationModule } from './mask-generation/mask-generation.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), MaskGenerationModule],
})
export class AppModule {}
