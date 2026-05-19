import { Body, Controller, Delete, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VideoService } from './video.service';

@Controller('videos')
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  @Get('health')
  health() {
    return { service: 'video-service', status: 'ok' };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: Express.Multer.File, @Body() body: { datasetId?: string; uploadedBy?: string }) {
    return this.videoService.upload(file, body);
  }

  @Get()
  list(@Query('datasetId') datasetId?: string) {
    return this.videoService.list(datasetId);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.videoService.findById(id);
  }

  @Get(':id/metadata')
  metadata(@Param('id') id: string) {
    return this.videoService.metadata(id);
  }

  @Post(':id/extract-frames')
  extractFrames(@Param('id') id: string, @Body() body: { sampleFps?: number; config?: Record<string, unknown> }) {
    return this.videoService.createFrameExtractionPipeline(id, body || {});
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.videoService.delete(id);
  }
}
