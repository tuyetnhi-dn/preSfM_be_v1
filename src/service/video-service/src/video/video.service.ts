import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import type { CreatePipelineBody, PipelineType } from '../type/pipline.type';
import { FrameAssetService } from './frame-asset.service';
import { FrameMaskPipelineService } from './frame-mask-pipeline.service';
import type { PreprocessAndMaskBody } from '../type/preprocess-mask.type';

type UploadBody = {
  datasetId?: string;
  uploadedBy?: string;
  projectName?: string;
};

type StorageUploadResponse = {
  id: string;
  provider: string;
  bucket: string;
  objectPath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

type DatasetRow = {
  id: string;
  project_id: string;
  name: string;
  status: string;
};

type PipelineRunRow = {
  id: string;
  dataset_id: string;
  video_id: string;
  status: string;
  progress: number;
  config: Record<string, unknown>;
  pipeline_type: string;
};

@Injectable()
export class VideoService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly frameAssetService: FrameAssetService,
    private readonly frameMaskPipelineService: FrameMaskPipelineService,
  ) {}

  private async createProject(
    userId?: string,
    projectName?: string,
  ): Promise<{
    id: string;
    name: string;
  }> {
    const name =
      projectName?.trim() ||
      `Project ${new Date().toISOString().slice(0, 10)} ${randomUUID().slice(0, 6)}`;

    const result = await this.databaseService.query(
      `INSERT INTO projects(user_id, name, status)
       VALUES ($1, $2, 'active')
       RETURNING id, name`,
      [userId ?? null, name],
    );

    return result.rows[0] as { id: string; name: string };
  }

  private async createDataset(
    userId?: string,
    projectName?: string,
  ): Promise<DatasetRow> {
    const project = await this.createProject(userId, projectName);

    const name = `Dataset ${new Date().toISOString().slice(0, 10)}`;

    const result = await this.databaseService.query(
      `INSERT INTO datasets(project_id, name, status,
                            raw_frame_count, selected_frame_count,
                            rejected_frame_count, mask_count)
       VALUES ($1, $2, 'created', 0, 0, 0, 0)
       RETURNING id, project_id, name, status`,
      [project.id, name],
    );

    return result.rows[0] as DatasetRow;
  }

  async upload(file: Express.Multer.File, body: UploadBody) {
    if (!file) {
      throw new BadRequestException('Video file is required');
    }

    if (!this.isAllowedVideo(file.mimetype, file.originalname)) {
      throw new BadRequestException('Unsupported video format');
    }

    const decodedName = Buffer.from(file.originalname, 'latin1').toString(
      'utf8',
    );

    const dataset = body.datasetId
      ? await this.getDataset(body.datasetId)
      : await this.createDataset(body.uploadedBy, body.projectName);

    const extension = this.fileExtension(decodedName);
    const objectPath = `projects/${dataset.project_id}/datasets/${dataset.id}/videos/${randomUUID()}${extension}`;

    const storageFile = await this.uploadToStorage(file, {
      bucket: this.configService.get<string>('VIDEO_BUCKET', 'videos'),
      path: objectPath,
      uploadedBy: body.uploadedBy,
      projectId: dataset.project_id,
      datasetId: dataset.id,
    });

    const result = await this.databaseService.query(
      `INSERT INTO videos(dataset_id, storage_file_id, original_name, mime_type, size_bytes, status)
       VALUES ($1, $2, $3, $4, $5, 'uploaded')
       RETURNING id, dataset_id, storage_file_id, original_name, mime_type, size_bytes, status, created_at`,
      [dataset.id, storageFile.id, decodedName, file.mimetype, file.size],
    );

    await this.databaseService.query(
      `UPDATE datasets SET status = 'ready' WHERE id = $1`,
      [dataset.id],
    );

    return {
      ...this.mapVideo(result.rows[0]),
      projectId: dataset.project_id,
      datasetId: dataset.id,
      storageFile: {
        ...storageFile,
        originalName: decodedName,
      },
    };
  }

  async list(datasetId?: string) {
    const result = datasetId
      ? await this.databaseService.query(
          `SELECT v.*, sf.bucket, sf.object_path
           FROM videos v
           JOIN storage_files sf ON sf.id = v.storage_file_id
           WHERE v.dataset_id = $1
           ORDER BY v.created_at DESC`,
          [datasetId],
        )
      : await this.databaseService.query(
          `SELECT v.*, sf.bucket, sf.object_path
           FROM videos v
           JOIN storage_files sf ON sf.id = v.storage_file_id
           ORDER BY v.created_at DESC
           LIMIT 100`,
        );

    return result.rows.map((row) => this.mapVideo(row));
  }

  async findById(id: string) {
    const result = await this.databaseService.query(
      `SELECT v.*, sf.bucket, sf.object_path, sf.provider
       FROM videos v
       JOIN storage_files sf ON sf.id = v.storage_file_id
       WHERE v.id = $1`,
      [id],
    );

    const video = result.rows[0];

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    return this.mapVideo(video);
  }

  async metadata(id: string) {
    const video = await this.findById(id);

    return {
      id: video.id,
      durationMs: video.durationMs,
      fps: video.fps,
      width: video.width,
      height: video.height,
      mimeType: video.mimeType,
      sizeBytes: video.sizeBytes,
    };
  }

  async createFrameExtractionPipeline(id: string, body: CreatePipelineBody) {
    const video = await this.findById(id);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const pipelineType = body.pipelineType as PipelineType;
    const config = this.buildPipelineConfig(body);

    const pipeline = await this.databaseService.query(
      `INSERT INTO pipeline_runs(dataset_id, video_id, status, progress, config, pipeline_type)
       VALUES ($1, $2, 'pending', 0, $3::jsonb, $4)
       RETURNING *`,
      [video.datasetId, id, JSON.stringify(config), pipelineType],
    );

    const pipelineRun = pipeline.rows[0] as PipelineRunRow;
    const steps = this.getStepsForPipeline(pipelineType);

    for (const [key, name] of steps) {
      await this.databaseService.query(
        `INSERT INTO pipeline_steps(pipeline_run_id, step_key, step_name)
         VALUES ($1, $2, $3)
         ON CONFLICT(pipeline_run_id, step_key) DO NOTHING`,
        [pipelineRun.id, key, name],
      );
    }

    await this.databaseService.query(
      `UPDATE videos SET status = 'frame_extracting' WHERE id = $1`,
      [id],
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return this.frameAssetService.runFrameExtraction({
      video,
      pipelineRun: {
        ...pipelineRun,
        pipeline_type: pipelineType,
      },
      pipelineType,
      config,
    });
  }

  async getVideoAssets(id: string) {
    await this.findById(id);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return this.frameAssetService.getVideoAssets(id);
  }

  async delete(id: string) {
    const video = await this.findById(id);

    await this.databaseService.query(`DELETE FROM videos WHERE id = $1`, [id]);

    return { success: true, deletedVideoId: video.id };
  }

  private async getDataset(datasetId: string): Promise<DatasetRow> {
    const result = await this.databaseService.query(
      `SELECT id, project_id, name, status FROM datasets WHERE id = $1`,
      [datasetId],
    );

    const dataset = result.rows[0];

    if (!dataset) {
      throw new NotFoundException('Dataset not found');
    }

    return dataset as DatasetRow;
  }

  private async uploadToStorage(
    file: Express.Multer.File,
    input: {
      bucket: string;
      path: string;
      uploadedBy?: string;
      projectId?: string;
      datasetId?: string;
    },
  ) {
    const formData = new FormData();

    formData.append(
      'file',
      new Blob([file.buffer as unknown as BlobPart], { type: file.mimetype }),
      file.originalname,
    );

    formData.append('bucket', input.bucket);
    formData.append('path', input.path);

    if (input.uploadedBy) {
      formData.append('uploadedBy', input.uploadedBy);
    }

    if (input.projectId) {
      formData.append('projectId', input.projectId);
    }

    if (input.datasetId) {
      formData.append('datasetId', input.datasetId);
    }

    const response = await fetch(`${this.storageServiceUrl()}/storage/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new BadRequestException(await response.text());
    }

    return (await response.json()) as StorageUploadResponse;
  }

  private storageServiceUrl() {
    return this.configService.get<string>(
      'STORAGE_SERVICE_URL',
      'http://storage-service:8004',
    );
  }

  private getStepsForPipeline(type: PipelineType): [string, string][] {
    const shared: [string, string][] = [
      ['frame_extract', 'Extract frames from video'],
    ];

    if (type === 'raw') {
      return [
        ...shared,
        ['opensfm_raw', 'Run OpenSfM with raw frames'],
        ['evaluation', 'Compare raw point cloud'],
      ];
    }

    return [
      ...shared,
      ['preprocessing', 'Filter noisy frames'],
      ['mask_generation', 'Generate dynamic masks via AI model'],
      ['opensfm_processed', 'Run OpenSfM with filtered frames + masks'],
      ['evaluation', 'Compare raw and processed point clouds'],
    ];
  }

  private buildPipelineConfig(body: CreatePipelineBody) {
    const bodyConfig =
      typeof body.config === 'object' && body.config !== null
        ? // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          (body.config as Record<string, unknown>)
        : {};

    return {
      ...bodyConfig,
      sampleFps: this.toNumber(body.sampleFps ?? bodyConfig.sampleFps, 2),
      outputRawFolder: this.toString(bodyConfig.outputRawFolder, 'raw_images'),
      outputMaskFolder: this.toString(bodyConfig.outputMaskFolder, 'masks'),
      outputProcessedFolder: this.toString(
        bodyConfig.outputProcessedFolder,
        'processed_images',
      ),
    };
  }

  private toNumber(value: unknown, fallback: number) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  }

  private toString(value: unknown, fallback: string) {
    return typeof value === 'string' && value.trim() ? value : fallback;
  }

  private isAllowedVideo(mimeType: string, filename: string) {
    const lower = filename.toLowerCase();

    return (
      mimeType.startsWith('video/') ||
      lower.endsWith('.mp4') ||
      lower.endsWith('.mov') ||
      lower.endsWith('.avi') ||
      lower.endsWith('.mkv')
    );
  }

  private fileExtension(filename: string) {
    const index = filename.lastIndexOf('.');
    return index >= 0 ? filename.slice(index).toLowerCase() : '.mp4';
  }

  private mapVideo(row: Record<string, unknown>) {
    return {
      id: row.id,
      datasetId: row.dataset_id,
      storageFileId: row.storage_file_id,
      originalName: row.original_name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      durationMs: row.duration_ms,
      fps: row.fps === null || row.fps === undefined ? null : Number(row.fps),
      width: row.width,
      height: row.height,
      status: row.status,
      bucket: row.bucket,
      objectPath: row.object_path,
      createdAt: row.created_at,
    };
  }
  async preprocessAndGenerateMasks(id: string, body: PreprocessAndMaskBody) {
    const video = await this.findById(id);

    const result = await this.frameMaskPipelineService.run({
      datasetId: String(video.datasetId),
      videoId: id,
      pipelineRunId: body.pipelineRunId,
      body,
    });

    const assets = await this.frameAssetService.getVideoAssets(id);

    return {
      pipelineRun: result.pipelineRun,
      total: result.total,
      selectedCount: result.selectedCount,
      rejectedCount: result.rejectedCount,
      images: result.images,
      rawImages: assets.rawImages,
      processedImages: assets.processedImages,
      masks: assets.masks,
      totalRawImages: assets.totalRawImages,
      totalProcessedImages: assets.totalProcessedImages,
      totalMasks: assets.totalMasks,
    };
  }
}
