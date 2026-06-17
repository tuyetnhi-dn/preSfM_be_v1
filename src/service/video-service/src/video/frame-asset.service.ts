/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../common/database/database.service';
import type { PipelineType } from '../type/pipline.type';
import { FrameExtractorService } from './frame-extractor.service';

type VideoView = {
  id: unknown;
  datasetId: unknown;
  storageFileId: unknown;
  bucket: unknown;
  objectPath: unknown;
};

type PipelineRunRow = {
  id: string;
  dataset_id: string;
  video_id: string;
  status: string;
  progress: number;
  config: Record<string, unknown>;
  pipeline_type: PipelineType;
};

type ExtractorFrame = {
  frameIndex?: number;
  frame_index?: number;
  timestampMs?: number;
  timestamp_ms?: number;
  width?: number | null;
  height?: number | null;
  rawStorageFileId?: string;
  raw_storage_file_id?: string;
  storageFileId?: string;
};

type NormalizedFrame = {
  frameIndex: number;
  timestampMs: number;
  width: number | null;
  height: number | null;
  rawStorageFileId: string;
};

type FrameExtractorResponse = {
  frames?: ExtractorFrame[];
  rawImages?: ExtractorFrame[];
};

type SignedAssetInput = {
  storageFileId: string;
  bucket: string | null;
  objectPath: string | null;
};

@Injectable()
export class FrameAssetService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly frameExtractorService: FrameExtractorService,
  ) {}

  async runFrameExtraction(input: {
    video: VideoView;
    pipelineRun: PipelineRunRow;
    pipelineType: PipelineType;
    config: Record<string, unknown>;
  }) {
    try {
      await this.updatePipelineRun(input.pipelineRun.id, {
        status: 'running',
        progress: 5,
        started_at: new Date().toISOString(),
      });

      await this.updatePipelineStep(input.pipelineRun.id, 'frame_extract', {
        status: 'running',
        progress: 10,
        started_at: new Date().toISOString(),
      });

      const extractorResult = await this.callFrameExtractor(input);
      const frames = this.normalizeFrames(extractorResult);

      await this.replaceRawFrames({
        datasetId: String(input.video.datasetId),
        videoId: String(input.video.id),
        frames,
      });

      await this.updateDatasetFrameCounts(
        String(input.video.datasetId),
        frames.length,
      );

      await this.updatePipelineStep(input.pipelineRun.id, 'frame_extract', {
        status: 'completed',
        progress: 100,
        completed_at: new Date().toISOString(),
      });

      const progress = input.pipelineType === 'raw' ? 100 : 25;

      const updatedPipelineRun = await this.updatePipelineRun(
        input.pipelineRun.id,
        {
          status: input.pipelineType === 'raw' ? 'completed' : 'running',
          progress,
          completed_at:
            input.pipelineType === 'raw' ? new Date().toISOString() : null,
        },
      );

      await this.databaseService.query(
        `UPDATE videos SET status = 'frames_extracted' WHERE id = $1`,
        [String(input.video.id)],
      );

      const assets = await this.getVideoAssets(String(input.video.id));

      return {
        pipelineRun: {
          ...this.mapPipelineRun(updatedPipelineRun),
          stage: 'raw_completed',
        },
        rawImages: assets.rawImages,
        processedImages: assets.processedImages,
        masks: assets.masks,
        totalRawImages: assets.totalRawImages,
        totalProcessedImages: assets.totalProcessedImages,
        totalMasks: assets.totalMasks,
      };
    } catch (error) {
      await this.updatePipelineRun(input.pipelineRun.id, {
        status: 'failed',
        error_message:
          error instanceof Error ? error.message : 'Frame extraction failed',
        completed_at: new Date().toISOString(),
      });

      await this.updatePipelineStep(input.pipelineRun.id, 'frame_extract', {
        status: 'failed',
        progress: 0,
        error_message:
          error instanceof Error ? error.message : 'Frame extraction failed',
        completed_at: new Date().toISOString(),
      });

      await this.databaseService.query(
        `UPDATE videos SET status = 'failed' WHERE id = $1`,
        [String(input.video.id)],
      );

      throw error;
    }
  }

  async getVideoAssets(videoId: string) {
    const result = await this.databaseService.query(
      `SELECT
       f.id,
       f.dataset_id,
       f.video_id,
       f.frame_index,
       f.timestamp_ms,
       f.width,
       f.height,
       f.blur_score,
       f.noise_score,
       f.is_selected,
       f.rejected_reason,

       f.raw_storage_file_id,
       f.processed_storage_file_id,
       f.mask_storage_file_id,

       raw_sf.bucket AS raw_bucket,
       raw_sf.object_path AS raw_object_path,

       processed_sf.bucket AS processed_bucket,
       processed_sf.object_path AS processed_object_path,

       mask_sf.bucket AS mask_bucket,
       mask_sf.object_path AS mask_object_path

     FROM frames f
     LEFT JOIN storage_files raw_sf ON raw_sf.id = f.raw_storage_file_id
     LEFT JOIN storage_files processed_sf ON processed_sf.id = f.processed_storage_file_id
     LEFT JOIN storage_files mask_sf ON mask_sf.id = f.mask_storage_file_id
     WHERE f.video_id = $1
     ORDER BY f.frame_index ASC`,
      [videoId],
    );

    const rawImages = await Promise.all(
      result.rows
        .filter((row) => row.raw_storage_file_id)
        .map(async (row) => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          id: row.id,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          frameIndex: row.frame_index,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          timestampMs: row.timestamp_ms,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          width: row.width,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          height: row.height,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          blurScore: row.blur_score,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          noiseScore: row.noise_score,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          isSelected: row.is_selected,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          rejectedReason: row.rejected_reason,
          raw: await this.createSignedAsset({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            storageFileId: row.raw_storage_file_id,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            bucket: row.raw_bucket,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            objectPath: row.raw_object_path,
          }),
        })),
    );

    const processedImages = await Promise.all(
      result.rows
        .filter((row) => row.processed_storage_file_id)
        .map(async (row) => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          id: row.id,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          frameIndex: row.frame_index,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          timestampMs: row.timestamp_ms,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          width: row.width,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          height: row.height,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          blurScore: row.blur_score,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          noiseScore: row.noise_score,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          isSelected: row.is_selected,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          rejectedReason: row.rejected_reason,
          processed: await this.createSignedAsset({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            storageFileId: row.processed_storage_file_id,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            bucket: row.processed_bucket,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            objectPath: row.processed_object_path,
          }),
        })),
    );

    const masks = await Promise.all(
      result.rows
        .filter((row) => row.mask_storage_file_id)
        .map(async (row) => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          id: row.id,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          frameIndex: row.frame_index,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          timestampMs: row.timestamp_ms,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          width: row.width,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          height: row.height,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          blurScore: row.blur_score,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          noiseScore: row.noise_score,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          isSelected: row.is_selected,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          rejectedReason: row.rejected_reason,
          mask: await this.createSignedAsset({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            storageFileId: row.mask_storage_file_id,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            bucket: row.mask_bucket,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            objectPath: row.mask_object_path,
          }),
        })),
    );

    return {
      videoId,
      folders: {
        rawImages,
        processedImages,
        masks,
      },
      rawImages,
      processedImages,
      masks,
      totalRawImages: rawImages.length,
      totalProcessedImages: processedImages.length,
      totalMasks: masks.length,
    };
  }

  private async callFrameExtractor(input: {
    video: VideoView;
    pipelineRun: PipelineRunRow;
    pipelineType: PipelineType;
    config: Record<string, unknown>;
  }) {
    const videoObjectPath = input.video.objectPath;
    const videoBucket = input.video.bucket;
    const videoStorageFileId = input.video.storageFileId;

    if (!videoObjectPath) {
      throw new BadRequestException('Missing video object path');
    }

    if (!videoBucket) {
      throw new BadRequestException('Missing video bucket');
    }

    if (!videoStorageFileId) {
      throw new BadRequestException('Missing video storage file id');
    }

    return this.frameExtractorService.extract({
      pipelineRunId: input.pipelineRun.id,
      pipelineType: input.pipelineType,
      datasetId: String(input.video.datasetId),
      videoId: String(input.video.id),
      sampleFps: Number(input.config.sampleFps ?? 2),
      videoStorageFileId: String(videoStorageFileId),
      videoStoragePath: String(videoObjectPath),
      videoStorageUrl: null,
      videoBucket: String(videoBucket),
      videoObjectPath: String(videoObjectPath),
      config: input.config,
    });
  }

  private normalizeFrames(response: FrameExtractorResponse): NormalizedFrame[] {
    const frames = response.frames ?? response.rawImages ?? [];

    if (!Array.isArray(frames) || frames.length === 0) {
      throw new BadRequestException('Frame extractor returned empty frames');
    }

    return frames.map((frame, index) => {
      const rawStorageFileId =
        frame.rawStorageFileId ??
        frame.raw_storage_file_id ??
        frame.storageFileId;

      if (!rawStorageFileId) {
        throw new BadRequestException(
          `Missing rawStorageFileId at frame index ${index}`,
        );
      }

      return {
        frameIndex: this.toNumber(frame.frameIndex ?? frame.frame_index, index),
        timestampMs: this.toNumber(frame.timestampMs ?? frame.timestamp_ms, 0),
        width: this.toNullableNumber(frame.width),
        height: this.toNullableNumber(frame.height),
        rawStorageFileId,
      };
    });
  }

  private async replaceRawFrames(input: {
    datasetId: string;
    videoId: string;
    frames: NormalizedFrame[];
  }) {
    await this.databaseService.query(`DELETE FROM frames WHERE video_id = $1`, [
      input.videoId,
    ]);

    const values: unknown[] = [];
    const placeholders = input.frames.map((frame, index) => {
      const offset = index * 8;

      values.push(
        input.datasetId,
        input.videoId,
        frame.frameIndex,
        frame.timestampMs,
        frame.rawStorageFileId,
        frame.width,
        frame.height,
        true,
      );

      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
    });

    await this.databaseService.query(
      `INSERT INTO frames(
         dataset_id,
         video_id,
         frame_index,
         timestamp_ms,
         raw_storage_file_id,
         width,
         height,
         is_selected
       )
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  private async updateDatasetFrameCounts(datasetId: string, count: number) {
    await this.databaseService.query(
      `UPDATE datasets
       SET raw_frame_count = $2,
           selected_frame_count = $2
       WHERE id = $1`,
      [datasetId, count],
    );
  }

  private async updatePipelineRun(
    pipelineRunId: string,
    fields: Record<string, unknown>,
  ) {
    const entries = Object.entries(fields).filter(
      ([, value]) => value !== undefined,
    );

    if (entries.length === 0) {
      const result = await this.databaseService.query(
        `SELECT * FROM pipeline_runs WHERE id = $1`,
        [pipelineRunId],
      );

      return result.rows[0];
    }

    const values = entries.map(([, value]) => value);
    const setClause = entries
      .map(([key], index) => `${key} = $${index + 2}`)
      .join(', ');

    const result = await this.databaseService.query(
      `UPDATE pipeline_runs
       SET ${setClause}, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [pipelineRunId, ...values],
    );

    if (!result.rows[0]) {
      throw new InternalServerErrorException('Cannot update pipeline run');
    }

    return result.rows[0];
  }

  private async updatePipelineStep(
    pipelineRunId: string,
    stepKey: string,
    fields: Record<string, unknown>,
  ) {
    const entries = Object.entries(fields).filter(
      ([, value]) => value !== undefined,
    );

    if (entries.length === 0) {
      return;
    }

    const values = entries.map(([, value]) => value);
    const setClause = entries
      .map(([key], index) => `${key} = $${index + 3}`)
      .join(', ');

    await this.databaseService.query(
      `UPDATE pipeline_steps
       SET ${setClause}
       WHERE pipeline_run_id = $1 AND step_key = $2`,
      [pipelineRunId, stepKey, ...values],
    );
  }

  private async createSignedAsset(input: SignedAssetInput) {
    const fallbackUrl = this.publicStorageDownloadUrl(input.storageFileId);

    if (!input.bucket || !input.objectPath) {
      return {
        storageFileId: input.storageFileId,
        bucket: input.bucket,
        path: input.objectPath,
        url: fallbackUrl,
      };
    }

    const query = `?bucket=${encodeURIComponent(
      input.bucket,
    )}&path=${encodeURIComponent(input.objectPath)}&expiresIn=3600`;

    try {
      const response = await fetch(
        `${this.storageServiceUrl()}/storage/signed-url${query}`,
        {
          method: 'GET',
        },
      );

      if (!response.ok) {
        return {
          storageFileId: input.storageFileId,
          bucket: input.bucket,
          path: input.objectPath,
          url: fallbackUrl,
        };
      }

      const data = (await response.json()) as Record<string, unknown>;

      const nestedData =
        typeof data.data === 'object' && data.data !== null
          ? (data.data as Record<string, unknown>)
          : {};

      const url =
        data.signedUrl ??
        data.signedURL ??
        data.url ??
        nestedData.signedUrl ??
        nestedData.signedURL ??
        nestedData.url ??
        fallbackUrl;

      return {
        storageFileId: input.storageFileId,
        bucket: input.bucket,
        path: input.objectPath,
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        url: String(url),
      };
    } catch {
      return {
        storageFileId: input.storageFileId,
        bucket: input.bucket,
        path: input.objectPath,
        url: fallbackUrl,
      };
    }
  }

  private publicStorageDownloadUrl(storageFileId: string) {
    const baseUrl = this.configService
      .get<string>('API_PUBLIC_URL', 'http://localhost:8000/api')
      .replace(/\/+$/, '');

    return `${baseUrl}/storage/files/${encodeURIComponent(storageFileId)}/download`;
  }

  private storageServiceUrl() {
    return this.configService.get<string>(
      'STORAGE_SERVICE_URL',
      'http://storage-service:8004',
    );
  }

  private toNumber(value: unknown, fallback: number) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  }

  private toNullableNumber(value: unknown) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  private mapPipelineRun(row: Record<string, unknown>) {
    return {
      id: row.id,
      datasetId: row.dataset_id,
      videoId: row.video_id,
      status: row.status,
      progress: row.progress,
      config: row.config,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pipelineType: row.pipeline_type,
    };
  }
}
