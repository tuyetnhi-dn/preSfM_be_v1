import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { FrameAssetService } from './frame-asset.service';
import { FrameExtractorService } from './frame-extractor.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [VideoController],
  providers: [VideoService, FrameAssetService, FrameExtractorService],
})
export class VideoModule {}
