import { Controller, Get, Param } from '@nestjs/common';
import { VideoService } from './video.service';

@Controller('projects')
export class ProjectController {
  constructor(private readonly videoService: VideoService) {}

  @Get(':projectId')
  getProjectById(@Param('projectId') projectId: string) {
    return this.videoService.getProjectById(projectId);
  }

  @Get(':projectId/assets')
  getProjectAssets(@Param('projectId') projectId: string) {
    return this.videoService.getProjectAssets(projectId);
  }

  @Get(':projectId/latest-pipeline')
  getLatestProjectPipeline(@Param('projectId') projectId: string) {
    return this.videoService.getLatestProjectPipeline(projectId);
  }
}
