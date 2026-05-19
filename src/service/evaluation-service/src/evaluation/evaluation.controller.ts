import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { EvaluationService } from './evaluation.service';

@Controller('evaluations')
export class EvaluationController {
  constructor(private readonly evaluationService: EvaluationService) {}

  @Get('health')
  health() {
    return { service: 'evaluation-service', status: 'ok' };
  }

  @Post('compare')
  compare(@Body() body: { pipelineRunId?: string; rawOpenSfmRunId?: string; processedOpenSfmRunId?: string }) {
    return this.evaluationService.compare(body);
  }

  @Get('by-pipeline/:pipelineRunId')
  findByPipeline(@Param('pipelineRunId') pipelineRunId: string) {
    return this.evaluationService.findByPipeline(pipelineRunId);
  }

  @Get(':id/metrics')
  metrics(@Param('id') id: string) {
    return this.evaluationService.metrics(id);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.evaluationService.findById(id);
  }
}
