import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { OpenSfmService } from './opensfm.service';

@Controller('opensfm')
export class OpenSfmController {
  constructor(private readonly openSfmService: OpenSfmService) {}

  @Get('health')
  health() {
    return { service: 'opensfm-service', status: 'ok' };
  }

  @Post('runs')
  createRun(@Body() body: { pipelineRunId?: string; datasetId?: string; branch?: 'raw' | 'processed'; workspacePath?: string; config?: Record<string, unknown> }) {
    return this.openSfmService.createRun(body);
  }

  @Get('runs')
  list(@Query('pipelineRunId') pipelineRunId?: string) {
    return this.openSfmService.list(pipelineRunId);
  }

  @Get('runs/:id')
  findById(@Param('id') id: string) {
    return this.openSfmService.findById(id);
  }

  @Post('runs/:id/start')
  start(@Param('id') id: string) {
    return this.openSfmService.start(id);
  }

  @Post('runs/:id/complete')
  complete(@Param('id') id: string, @Body() body: { status?: 'completed' | 'failed'; reconstructionFileId?: string; sparsePlyFileId?: string; densePlyFileId?: string; statsFileId?: string; reportFileId?: string; commandLog?: string; metrics?: Record<string, unknown>; processingTimeMs?: number; errorMessage?: string }) {
    return this.openSfmService.complete(id, body || {});
  }

  @Get('runs/:id/outputs')
  outputs(@Param('id') id: string) {
    return this.openSfmService.outputs(id);
  }

  @Get('runs/:id/logs')
  logs(@Param('id') id: string) {
    return this.openSfmService.logs(id);
  }
}
