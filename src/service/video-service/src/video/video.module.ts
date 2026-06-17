import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { FrameAssetService } from './frame-asset.service';
import { FrameExtractorService } from './frame-extractor.service';
import { ConfigModule } from '@nestjs/config';
import { FrameMaskPipelineService } from './frame-mask-pipeline.service';
import { OpenSfMComparisonService } from './opensfm-comparison.service';
import { BullModule } from '@nestjs/bullmq';
import { FULL_PIPELINE_QUEUE } from '../pipeline/pipeline-queue.constants';
import { FullPipelineQueueService } from './full-pipeline-queue.service';
import { FullPipelineProcessor } from './full-pipeline.processor';
import { VideoPipelineRunnerService } from './video-pipeline-runner.service';
import { ProjectController } from '../project/project.controller';
import { ProjectService } from '../project/project.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    BullModule.registerQueue({
      name: FULL_PIPELINE_QUEUE,
    }),
  ],
  controllers: [VideoController, ProjectController],
  providers: [
    VideoService,
    ProjectService,
    FrameAssetService,
    FrameExtractorService,
    FrameMaskPipelineService,
    OpenSfMComparisonService,
    FullPipelineQueueService,
    FullPipelineProcessor,
    VideoPipelineRunnerService,
  ],
})
export class VideoModule {}
