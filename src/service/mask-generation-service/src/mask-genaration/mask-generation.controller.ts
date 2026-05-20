import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import type {
  MaskGenerationService,
  GenerateMaskJobInput,
} from './mask-generation.service';

@Controller('masks')
export class MaskGenerationController {
  constructor(private readonly maskGenerationService: MaskGenerationService) {}

  @Post('health')
  health() {
    return { service: 'mask-generation-service', status: 'ok' };
  }

  /**
   * POST /masks/generate
   * Nhận danh sách đường dẫn ảnh đã filter + output dir,
   * trả về danh sách mask đã generate.
   */
  @Post('generate')
  async generate(@Body() body: GenerateMaskJobInput) {
    if (!body.pipelineRunId) {
      throw new BadRequestException('pipelineRunId is required');
    }
    if (!body.imagesPaths?.length) {
      throw new BadRequestException('imagesPaths must not be empty');
    }
    if (!body.outputMasksDir) {
      throw new BadRequestException('outputMasksDir is required');
    }

    return this.maskGenerationService.generateMasks(body);
  }
}
