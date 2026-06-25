/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Job } from 'bullmq';
import { DatabaseService } from '../common/database/database.service';
import { ExtractInput, FrameExtractorService } from './frame-extractor.service';
import { FrameMaskPipelineService } from './frame-mask-pipeline.service';
import { FrameAssetService } from './frame-asset.service';
import { OpenSfMComparisonService } from './opensfm-comparison.service';
import { FullPipelineJobData } from '../type/full-pipeline-job.type';

type VideoRow = {
  id: string;
  dataset_id: string;
  storage_file_id: string;
  object_path: string;
  bucket: string;
};

@Injectable()
export class VideoPipelineRunnerService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly frameExtractorService: FrameExtractorService,
    private readonly frameMaskPipelineService: FrameMaskPipelineService,
    private readonly frameAssetService: FrameAssetService,
    private readonly openSfMComparisonService: OpenSfMComparisonService,
  ) {}

  async run(data: FullPipelineJobData, job: Job<FullPipelineJobData>) {
    const { videoId, pipelineRunId, dto } = data;

    try {
      const video = await this.getVideoRow(videoId);
      const datasetId = String(video.dataset_id);

      await this.setPipelineState(job, {
        pipelineRunId,
        status: 'running',
        progress: 5,
        currentStage: 'started',
        errorMessage: null,
        started: true,
      });

      await this.updateVideoStatus(videoId, 'processing');
      await this.updateDatasetStatus(datasetId, 'processing');

      await this.markStepRunning(pipelineRunId, 'frame_extract', 10);

      const extractInput: ExtractInput = {
        pipelineRunId,
        pipelineType: 'processed',
        datasetId,
        videoId,
        sampleFps: dto.sampleFps ?? 2,
        videoStorageFileId: video.storage_file_id,
        videoStoragePath: video.object_path,
        videoStorageUrl: null,
        videoBucket: video.bucket,
        videoObjectPath: video.object_path,
        config: {
          outputRawFolder: 'raw_images',
          outputProcessedFolder: 'processed_images',
          outputMaskFolder: 'masks',
        },
      };

      await this.frameExtractorService.extract(extractInput);

      await this.markStepCompleted(pipelineRunId, 'frame_extract');

      await this.setPipelineState(job, {
        pipelineRunId,
        status: 'running',
        progress: 35,
        currentStage: 'frames_extracted',
      });

      await this.markStepRunning(pipelineRunId, 'preprocessing', 40);
      await this.markStepRunning(pipelineRunId, 'mask_generation', 45);

      await this.frameMaskPipelineService.run(videoId, {
        datasetId,
        videoId,
        pipelineRunId,
        body: {
          pipelineRunId,
          config: {
            blurThreshold: dto.blurThreshold ?? 250,
            noiseThreshold: dto.noiseThreshold ?? 25,
            outputProcessedFolder: 'processed_images',
            outputMaskFolder: 'masks',
          },
        },
      });

      await this.markStepCompleted(pipelineRunId, 'preprocessing');
      await this.markStepCompleted(pipelineRunId, 'mask_generation');

      await this.setPipelineState(job, {
        pipelineRunId,
        status: 'running',
        progress: 65,
        currentStage: 'masks_completed',
      });

      const assets = await this.frameAssetService.getVideoAssets(videoId);

      if (
        assets.totalProcessedImages <= 0 ||
        assets.totalProcessedImages !== assets.totalMasks
      ) {
        throw new BadRequestException(
          `Invalid assets before OpenSfM: processed=${assets.totalProcessedImages}, masks=${assets.totalMasks}`,
        );
      }

      await this.markStepRunning(pipelineRunId, 'opensfm_raw', 70);
      await this.markStepRunning(pipelineRunId, 'opensfm_processed', 75);

      const opensfmResult = await this.openSfMComparisonService.compare({
        datasetId,
        videoId,
        assets,
        runDense: dto.runDense ?? true,
      });

      await this.markStepCompleted(pipelineRunId, 'opensfm_raw');
      await this.markStepCompleted(pipelineRunId, 'opensfm_processed');

      await this.markStepRunning(pipelineRunId, 'evaluation', 90);
      await this.markStepCompleted(pipelineRunId, 'evaluation');

      await this.setPipelineState(job, {
        pipelineRunId,
        status: 'completed',
        progress: 100,
        currentStage: 'completed',
        result: opensfmResult as Record<string, unknown>,
        completed: true,
      });

      await this.updateVideoStatus(videoId, 'completed');
      await this.updateDatasetStatus(datasetId, 'completed');

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return opensfmResult;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown pipeline error';

      await this.setPipelineState(job, {
        pipelineRunId,
        status: 'failed',
        progress: 100,
        currentStage: 'failed',
        errorMessage: message,
        completed: true,
      });

      await this.updateVideoStatus(videoId, 'failed');
      await this.failRunningSteps(pipelineRunId, message);

      throw error;
    }
  }

  private async getVideoRow(videoId: string): Promise<VideoRow> {
    const result = await this.databaseService.query(
      `
    SELECT
      v.id,
      v.dataset_id,
      v.storage_file_id,
      sf.object_path,
      sf.bucket
    FROM videos v
    JOIN storage_files sf ON sf.id = v.storage_file_id
    WHERE v.id = $1
    LIMIT 1
    `,
      [videoId],
    );

    const video = result.rows[0] as VideoRow | undefined;

    if (!video) {
      throw new NotFoundException(`Video ${videoId} not found`);
    }

    if (!video.dataset_id) {
      throw new BadRequestException(`Video ${videoId} does not have datasetId`);
    }

    if (!video.storage_file_id) {
      throw new BadRequestException(
        `Video ${videoId} does not have storageFileId`,
      );
    }

    if (!video.object_path) {
      throw new BadRequestException(
        `Video ${videoId} does not have storage object path`,
      );
    }

    if (!video.bucket) {
      throw new BadRequestException(`Video ${videoId} does not have bucket`);
    }

    return video;
  }

  private async setPipelineState(
    job: Job<FullPipelineJobData>,
    input: {
      pipelineRunId: string;
      status: string;
      progress: number;
      currentStage?: string | null;
      result?: Record<string, unknown> | null;
      errorMessage?: string | null;
      started?: boolean;
      completed?: boolean;
    },
  ) {
    await job.updateProgress(input.progress);

    await this.databaseService.query(
      `
      UPDATE pipeline_runs
      SET status = $2,
          progress = $3,
          current_stage = COALESCE($4, current_stage),
          result = COALESCE($5::jsonb, result),
          error_message = $6,
          started_at = CASE
            WHEN $7 = true AND started_at IS NULL THEN NOW()
            ELSE started_at
          END,
          completed_at = CASE
            WHEN $8 = true THEN NOW()
            ELSE completed_at
          END,
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        input.pipelineRunId,
        input.status,
        input.progress,
        input.currentStage ?? null,
        input.result ? JSON.stringify(input.result) : null,
        input.errorMessage ?? null,
        input.started ?? false,
        input.completed ?? false,
      ],
    );
  }

  private async markStepRunning(
    pipelineRunId: string,
    stepKey: string,
    progress: number,
  ) {
    await this.databaseService.query(
      `
      UPDATE pipeline_steps
      SET status = 'running',
          progress = $3,
          started_at = COALESCE(started_at, NOW()),
          updated_at = NOW()
      WHERE pipeline_run_id = $1
        AND step_key = $2
      `,
      [pipelineRunId, stepKey, progress],
    );
  }

  private async markStepCompleted(pipelineRunId: string, stepKey: string) {
    await this.databaseService.query(
      `
      UPDATE pipeline_steps
      SET status = 'completed',
          progress = 100,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE pipeline_run_id = $1
        AND step_key = $2
      `,
      [pipelineRunId, stepKey],
    );
  }

  private async failRunningSteps(pipelineRunId: string, errorMessage: string) {
    await this.databaseService.query(
      `
      UPDATE pipeline_steps
      SET status = 'failed',
          error_message = $2,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE pipeline_run_id = $1
        AND status = 'running'
      `,
      [pipelineRunId, errorMessage],
    );
  }

  private async updateVideoStatus(videoId: string, status: string) {
    await this.databaseService.query(
      `
      UPDATE videos
      SET status = $2
      WHERE id = $1
      `,
      [videoId, status],
    );
  }

  private async updateDatasetStatus(datasetId: string, status: string) {
    await this.databaseService.query(
      `
      UPDATE datasets
      SET status = $2
      WHERE id = $1
      `,
      [datasetId, status],
    );
  }
}
