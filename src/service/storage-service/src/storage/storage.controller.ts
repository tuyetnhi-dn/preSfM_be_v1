import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { StorageService } from './storage.service';

@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Get('health')
  health() {
    return { service: 'storage-service', status: 'ok' };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(
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
    return this.storageService.upload({ file, ...body });
  }

  @Get('signed-url')
  signedUrl(
    @Query('bucket') bucket: string,
    @Query('path') path: string,
    @Query('expiresIn') expiresIn?: string,
  ) {
    return this.storageService.signedUrl(
      bucket,
      path,
      Number(expiresIn || 3600),
    );
  }

  @Get('files/:id')
  findById(@Param('id') id: string) {
    return this.storageService.findById(id);
  }

  @Get('files/:id/download')
  async download(@Param('id') id: string, @Res() response: Response) {
    const file = await this.storageService.downloadById(id);
    response.setHeader('content-type', file.mimeType);
    response.setHeader('content-length', String(file.buffer.length));
    response.setHeader(
      'content-disposition',
      `attachment; filename="${encodeURIComponent(file.filename)}"`,
    );
    response.send(file.buffer);
  }

  @Delete('files/:id')
  remove(@Param('id') id: string) {
    return this.storageService.remove(id);
  }
}
