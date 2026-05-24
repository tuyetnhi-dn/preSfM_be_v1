import { Body, Controller, Get, Post } from '@nestjs/common';
import { MaskGenerationService } from './mask-generation.service';
import type { ProcessRawFramesInput } from './mask-generation.service';

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

  @Post('process-raw-frames')
  processRawFrames(@Body() body: ProcessRawFramesInput) {
    return this.maskGenerationService.processRawFrames(body);
  }
}
