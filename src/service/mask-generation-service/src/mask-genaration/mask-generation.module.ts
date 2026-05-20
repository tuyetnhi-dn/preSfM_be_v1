import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MaskGenerationController } from './mask-generation.controller';
import { MaskGenerationService } from './mask-generation.service';

@Module({
  imports: [ConfigModule], // Cần thiết để ConfigService hoạt động
  controllers: [MaskGenerationController],
  providers: [MaskGenerationService],
  exports: [MaskGenerationService], // Export nếu các module khác cần gọi trực tiếp service này
})
export class MaskGenerationModule {}
