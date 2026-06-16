import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { FrameAssetService } from './frame-asset.service';
import { FrameExtractorService } from './frame-extractor.service';
import { ConfigModule } from '@nestjs/config';
import { FrameMaskPipelineService } from './frame-mask-pipeline.service';
import { OpenSfMComparisonService } from './opensfm-comparison.service';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [VideoController],
  providers: [
    VideoService,
    FrameAssetService,
    FrameExtractorService,
    FrameMaskPipelineService,
    OpenSfMComparisonService,
  ],
})
export class VideoModule {}
