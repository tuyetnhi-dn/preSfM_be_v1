/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// import type { Response } from 'express';
// import * as Express from 'express';
import type { Response } from 'express';
import { GatewayService } from './gateway.service';

@Controller('api')
export class GatewayController {
  constructor(private readonly gatewayService: GatewayService) {}

  @Get('health')
  health() {
    return { service: 'gateway-service', status: 'ok' };
  }

  @Post('auth/send-otp')
  sendOtp(@Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/send-otp',
      method: 'POST',
      body,
    });
  }

  @Post('auth/register')
  register(@Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/register',
      method: 'POST',
      body,
    });
  }

  @Post('auth/login')
  login(@Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/login',
      method: 'POST',
      body,
    });
  }

  @Post('auth/refresh')
  refresh(@Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/refresh',
      method: 'POST',
      body,
    });
  }

  @Post('auth/logout')
  logout(@Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/logout',
      method: 'POST',
      body,
    });
  }

  @Get('auth/me')
  getMe(@Headers('authorization') authorization: string | undefined) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/me',
      method: 'GET',
      authorization,
    });
  }

  @Post('videos/upload')
  @UseInterceptors(FileInterceptor('file'))
  uploadVideo(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { datasetId?: string; uploadedBy?: string },
  ) {
    return this.gatewayService.multipartUpload({
      service: 'video',
      path: '/videos/upload',
      file,
      fields: body,
    });
  }

  @Get('videos')
  listVideos(@Query('datasetId') datasetId?: string) {
    const query = datasetId
      ? `?datasetId=${encodeURIComponent(datasetId)}`
      : '';
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos${query}`,
      method: 'GET',
    });
  }

  @Get('videos/:id/metadata')
  videoMetadata(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/${id}/metadata`,
      method: 'GET',
    });
  }

  @Get('videos/:id/assets')
  videoAssets(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/${id}/assets`,
      method: 'GET',
    });
  }

  @Post('videos/:id/extract-frames')
  extractFrames(@Param('id') id: string, @Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/${id}/extract-frames`,
      method: 'POST',
      body,
    });
  }

  @Post('videos/:id/preprocess-and-generate-masks')
  preprocessAndGenerateMasks(@Param('id') id: string, @Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/${id}/preprocess-and-generate-masks`,
      method: 'POST',
      body,
    });
  }

  @Post('videos/:id/run-opensfm-comparison')
  runOpenSfMComparison(@Param('id') id: string, @Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/${id}/run-opensfm-comparison`,
      method: 'POST',
      body,
    });
  }
  @Post('videos/:id/run-full-pipeline')
  startFullPipeline(@Param('id') id: string, @Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/${id}/run-full-pipeline`,
      method: 'POST',
      body,
    });
  }

  @Get('videos/pipeline-runs/:pipelineRunId/status')
  getPipelineRunStatus(@Param('pipelineRunId') pipelineRunId: string) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/pipeline-runs/${pipelineRunId}/status`,
      method: 'GET',
    });
  }

  @Get('videos/:id')
  findVideo(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/${id}`,
      method: 'GET',
    });
  }

  @Delete('videos/:id')
  deleteVideo(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/videos/${id}`,
      method: 'DELETE',
    });
  }
  @Get('projects/:projectId')
  getProjectById(@Param('projectId') projectId: string) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/projects/${projectId}`,
      method: 'GET',
    });
  }

  @Get('projects/:projectId/assets')
  getProjectAssets(@Param('projectId') projectId: string) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/projects/${projectId}/assets`,
      method: 'GET',
    });
  }

  @Get('projects/:projectId/latest-pipeline')
  getLatestProjectPipeline(@Param('projectId') projectId: string) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/projects/${projectId}/latest-pipeline`,
      method: 'GET',
    });
  }
  @Get('projects')
  listProjects(@Query() query: Record<string, unknown>) {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, String(value));
      }
    }

    const suffix = searchParams.toString();

    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/projects${suffix ? `?${suffix}` : ''}`,
      method: 'GET',
    });
  }

  @Get('projects/:id')
  getProjectofUserById(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, String(value));
      }
    }

    const suffix = searchParams.toString();

    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/projects/${id}${suffix ? `?${suffix}` : ''}`,
      method: 'GET',
    });
  }
  @Patch('projects/:id/visibility')
  updateVisibility(
    @Param('id') id: string,
    @Query('userId') userId: string,
    @Body() body: { visibility?: 'public' | 'private' },
  ) {
    return this.gatewayService.jsonRequest({
      service: 'video',
      path: `/projects/${id}/visibility?userId=${userId}`,
      method: 'PATCH',
      body,
    });
  }

  @Post('auth/forgot-password')
  forgotPassword(@Body() body: { email?: string }) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/forgot-password',
      method: 'POST',
      body,
    });
  }
  @Post('auth/reset-password')
  resetPassword(
    @Body()
    body: {
      token?: string;
      newPassword?: string;
    },
  ) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/reset-password',
      method: 'POST',
      body,
    });
  }
  @Post('auth/change-password')
  changePassword(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      oldPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    },
  ) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/change-password',
      method: 'POST',
      authorization,
      body,
    });
  }
  @Patch('auth/profile')
  updateProfile(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      fullName?: string;
    },
  ) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/auth/profile',
      method: 'PATCH',
      headers: authorization
        ? {
            authorization,
          }
        : undefined,
      body,
    });
  }

  @Post('storage/upload')
  @UseInterceptors(FileInterceptor('file'))
  uploadStorage(
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: {
      bucket?: string;
      path?: string;
      uploadedBy?: string;
      projectId?: string;
      datasetId?: string;
    },
  ) {
    return this.gatewayService.multipartUpload({
      service: 'storage',
      path: '/storage/upload',
      file,
      fields: body,
    });
  }

  @Get('storage/signed-url')
  storageSignedUrl(
    @Query('bucket') bucket: string,
    @Query('path') path: string,
    @Query('expiresIn') expiresIn?: string,
  ) {
    const query = `?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}&expiresIn=${encodeURIComponent(expiresIn || '3600')}`;
    return this.gatewayService.jsonRequest({
      service: 'storage',
      path: `/storage/signed-url${query}`,
      method: 'GET',
    });
  }

  @Get('storage/files/:id')
  storageFile(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'storage',
      path: `/storage/files/${id}`,
      method: 'GET',
    });
  }

  @Get('storage/files/:id/download')
  async downloadStorageFile(
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const file = await this.gatewayService.binaryRequest({
      service: 'storage',
      path: `/storage/files/${id}/download`,
      method: 'GET',
    });
    response.setHeader('content-type', file.contentType);
    if (file.contentDisposition) {
      response.setHeader('content-disposition', file.contentDisposition);
    }
    response.send(file.buffer);
  }

  @Delete('storage/files/:id')
  deleteStorageFile(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'storage',
      path: `/storage/files/${id}`,
      method: 'DELETE',
    });
  }

  @Post('opensfm/runs')
  createOpenSfmRun(@Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'opensfm',
      path: '/opensfm/runs',
      method: 'POST',
      body,
    });
  }

  @Get('opensfm/runs')
  listOpenSfmRuns(@Query('pipelineRunId') pipelineRunId?: string) {
    const query = pipelineRunId
      ? `?pipelineRunId=${encodeURIComponent(pipelineRunId)}`
      : '';
    return this.gatewayService.jsonRequest({
      service: 'opensfm',
      path: `/opensfm/runs${query}`,
      method: 'GET',
    });
  }

  @Get('opensfm/runs/:id')
  findOpenSfmRun(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'opensfm',
      path: `/opensfm/runs/${id}`,
      method: 'GET',
    });
  }

  @Post('opensfm/runs/:id/start')
  startOpenSfmRun(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'opensfm',
      path: `/opensfm/runs/${id}/start`,
      method: 'POST',
    });
  }

  @Post('opensfm/runs/:id/complete')
  completeOpenSfmRun(@Param('id') id: string, @Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'opensfm',
      path: `/opensfm/runs/${id}/complete`,
      method: 'POST',
      body,
    });
  }

  @Get('opensfm/runs/:id/outputs')
  openSfmOutputs(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'opensfm',
      path: `/opensfm/runs/${id}/outputs`,
      method: 'GET',
    });
  }

  @Get('opensfm/runs/:id/logs')
  openSfmLogs(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'opensfm',
      path: `/opensfm/runs/${id}/logs`,
      method: 'GET',
    });
  }

  @Post('evaluations/compare')
  compareEvaluations(@Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'evaluation',
      path: '/evaluations/compare',
      method: 'POST',
      body,
    });
  }

  @Get('evaluations/by-pipeline/:pipelineRunId')
  evaluationByPipeline(@Param('pipelineRunId') pipelineRunId: string) {
    return this.gatewayService.jsonRequest({
      service: 'evaluation',
      path: `/evaluations/by-pipeline/${pipelineRunId}`,
      method: 'GET',
    });
  }

  @Get('evaluations/:id')
  findEvaluation(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'evaluation',
      path: `/evaluations/${id}`,
      method: 'GET',
    });
  }

  @Get('evaluations/:id/metrics')
  evaluationMetrics(@Param('id') id: string) {
    return this.gatewayService.jsonRequest({
      service: 'evaluation',
      path: `/evaluations/${id}/metrics`,
      method: 'GET',
    });
  }

  @Get('masks/health')
  maskHealth() {
    return this.gatewayService.jsonRequest({
      service: 'mask',
      path: '/masks/health',
      method: 'GET',
    });
  }

  @Post('masks/generate')
  generateMasks(@Body() body: unknown) {
    return this.gatewayService.jsonRequest({
      service: 'mask',
      path: '/masks/generate',
      method: 'POST',
      body,
    });
  }
  @Get('admin/stats')
  getAdminStats(@Headers('authorization') authorization: string | undefined) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/admin/stats',
      method: 'GET',
      headers: authorization
        ? {
            authorization,
          }
        : undefined,
    });
  }

  @Get('admin/users')
  getAdminUsers(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/admin/users',
      method: 'GET',
      authorization,
      query,
    });
  }

  @Patch('admin/users/:id/status')
  updateAdminUserStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: `/admin/users/${id}/status`,
      method: 'PATCH',
      authorization,
      body,
    });
  }
  @Get('admin/users/:id')
  getAdminUserDetail(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Query() query: Record<string, string>,
  ) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: `/admin/users/${id}`,
      method: 'GET',
      authorization,
      query,
    });
  }

  @Get('admin/projects/:id')
  getAdminProjectDetail(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: `/admin/projects/${id}`,
      method: 'GET',
      authorization,
    });
  }
  @Get('admin/projects')
  getAdminProjects(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    return this.gatewayService.jsonRequest({
      service: 'auth',
      path: '/admin/projects',
      method: 'GET',
      authorization,
      query,
    });
  }
}
