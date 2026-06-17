import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { VideoService } from '../video/video.service';
import { ProjectService } from './project.service';
import type { ProjectListQuery } from './project-list.type';
// import { UpdateVisibilityDto } from './updateVisibility.dto';

@Controller('projects')
export class ProjectController {
  constructor(
    private readonly videoService: VideoService,
    private readonly projectService: ProjectService,
  ) {}

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
  @Patch(':id/visibility')
  updateVisibility(
    @Param('id') id: string,
    @Query('userId') userId: string,
    @Body() body: { visibility: 'public' | 'private' },
  ) {
    return this.projectService.updateVisibility({
      projectId: id,
      userId,
      visibility: body.visibility,
    });
  }
  @Get()
  listProjects(@Query() query: ProjectListQuery) {
    return this.projectService.listProjects(query);
  }

  @Get(':id')
  getProjectofUserById(
    @Param('id') id: string,
    @Query('userId') userId?: string,
  ) {
    return this.projectService.getProjectofUserById({
      projectId: id,
      userId,
    });
  }
}
