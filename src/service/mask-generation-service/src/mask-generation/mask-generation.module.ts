import { Module } from '@nestjs/common';
import { MaskGenerationController } from './mask-generation.controller';
import { MaskGenerationService } from './mask-generation.service';

@Module({
  controllers: [MaskGenerationController],
  providers: [MaskGenerationService],
  exports: [MaskGenerationService],
})
export class MaskGenerationModule {}
