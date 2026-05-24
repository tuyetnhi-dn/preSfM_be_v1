import { Body, Controller, Get, Post } from '@nestjs/common';
import { MaskGenerationService } from './mask-generation.service';
import type {
  GenerateMaskJobInput,
  ProcessRawFramesInput,
} from './mask-generation.service';

@Controller('mask-generation')
export class MaskGenerationController {
  constructor(private readonly maskGenerationService: MaskGenerationService) {}

  @Get('health')
  health() {
    return {
      service: 'mask-generation-service',
      status: 'ok',
    };
  }

  @Post('generate')
  generateMasks(@Body() body: GenerateMaskJobInput) {
    return this.maskGenerationService.generateMasks(body);
  }

  @Post('process-raw-frames')
  processRawFrames(@Body() body: ProcessRawFramesInput) {
    return this.maskGenerationService.processRawFrames(body);
  }
}
