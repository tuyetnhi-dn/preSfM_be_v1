/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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
import { OpenSfMComparisonService } from './opensfm-comparison.service';
import type { RunOpenSfMComparisonBody } from '../type/run-opensfm-comparison.type';
import type {
  PipelineRunStatusResponse,
  RunFullPipelineDto,
  RunFullPipelineResponse,
} from '../type/run-full-pipeline.type';
import { FrameExtractorService } from './frame-extractor.service';
import { FullPipelineQueueService } from './full-pipeline-queue.service';
import { ProjectVisibility } from '../project/project-list.type';
import { UploadBody } from '../type/upload-video.type';

const parsePage = (value: string | undefined): number => {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

const parseLimit = (value: string | undefined): number => {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 && limit <= 100 ? limit : 10;
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
  project_name?: string | null;
  project_description?: string | null;
  project_visibility?: ProjectVisibility | null;
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

function buildSupabasePublicUrl(input: {
  bucket?: string | null;
  objectPath?: string | null;
}) {
  if (!input.bucket || !input.objectPath) return null;

  const supabaseUrl = process.env.SUPABASE_URL;

  if (!supabaseUrl) return null;

  const baseUrl = supabaseUrl.replace(/\/$/, '');

  const encodedObjectPath = input.objectPath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  return `${baseUrl}/storage/v1/object/public/${input.bucket}/${encodedObjectPath}`;
}
@Injectable()
export class VideoService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly frameAssetService: FrameAssetService,
    private readonly frameMaskPipelineService: FrameMaskPipelineService,
    private readonly openSfMComparisonService: OpenSfMComparisonService,
    private readonly frameExtractorService: FrameExtractorService,
    private readonly fullPipelineQueueService: FullPipelineQueueService,
  ) {}
  private normalizeOptionalText(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private normalizeProjectVisibility(value: unknown): ProjectVisibility {
    return value === 'public' ? 'public' : 'private';
  }

  private async createProject(input: {
    userId?: string;
    projectName?: string;
    description?: string;
    visibility?: string;
  }): Promise<{
    id: string;
    name: string;
    description: string | null;
    visibility: ProjectVisibility;
  }> {
    const name =
      this.normalizeOptionalText(input.projectName) ||
      `Project ${new Date().toISOString().slice(0, 10)} ${randomUUID().slice(0, 6)}`;

    const description = this.normalizeOptionalText(input.description);
    const visibility = this.normalizeProjectVisibility(input.visibility);

    const result = await this.databaseService.query(
      `
    INSERT INTO projects (
      user_id,
      name,
      description,
      visibility,
      status,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
    RETURNING id, name, description, visibility
    `,
      [input.userId ?? null, name, description, visibility],
    );

    return result.rows[0] as {
      id: string;
      name: string;
      description: string | null;
      visibility: ProjectVisibility;
    };
  }

  private async createDataset(input: {
    userId?: string;
    projectName?: string;
    description?: string;
    visibility?: string;
    datasetName?: string;
  }): Promise<DatasetRow> {
    const project = await this.createProject({
      userId: input.userId,
      projectName: input.projectName,
      description: input.description,
      visibility: input.visibility,
    });

    const name =
      this.normalizeOptionalText(input.datasetName) ||
      `Dataset ${new Date().toISOString().slice(0, 10)}`;

    const result = await this.databaseService.query(
      `
    INSERT INTO datasets (
      project_id,
      name,
      status,
      raw_frame_count,
      selected_frame_count,
      rejected_frame_count,
      mask_count,
      created_at,
      updated_at
    )
    VALUES ($1, $2, 'created', 0, 0, 0, 0, NOW(), NOW())
    RETURNING id, project_id, name, status
    `,
      [project.id, name],
    );

    const dataset = result.rows[0] as DatasetRow;

    return {
      ...dataset,
      project_name: project.name,
      project_description: project.description,
      project_visibility: project.visibility,
    };
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
      : await this.createDataset({
          userId: body.uploadedBy,
          projectName: body.projectName,
          description: body.description,
          visibility: body.visibility,
          datasetName: body.datasetName,
        });

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
      project: {
        id: dataset.project_id,
        name: dataset.project_name ?? body.projectName ?? null,
        description: dataset.project_description ?? body.description ?? null,
        visibility:
          dataset.project_visibility ??
          this.normalizeProjectVisibility(body.visibility),
      },
      dataset: {
        id: dataset.id,
        name: dataset.name,
        status: dataset.status,
      },
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
    return this.frameAssetService.getVideoAssets(id);
  }

  async delete(id: string) {
    const video = await this.findById(id);

    await this.databaseService.query(`DELETE FROM videos WHERE id = $1`, [id]);

    return { success: true, deletedVideoId: video.id };
  }

  private async getDataset(datasetId: string): Promise<DatasetRow> {
    const result = await this.databaseService.query(
      `
    SELECT
      d.id,
      d.project_id,
      d.name,
      d.status,
      p.name AS project_name,
      p.description AS project_description,
      p.visibility AS project_visibility
    FROM datasets d
    JOIN projects p ON p.id = d.project_id
    WHERE d.id = $1
    LIMIT 1
    `,
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

    const result = await this.frameMaskPipelineService.run(id, {
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
  async runOpenSfMComparison(id: string, body: RunOpenSfMComparisonBody) {
    const video = await this.findById(id);
    const assets = await this.frameAssetService.getVideoAssets(id);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.openSfMComparisonService.compare({
      datasetId: String(video.datasetId),
      videoId: id,
      assets,
      runDense: body.runDense ?? true,
    });
  }

  private async updatePipelineRun(input: {
    pipelineRunId: string;
    status: string;
    progress: number;
    currentStage?: string | null;
    result?: Record<string, unknown> | null;
    errorMessage?: string | null;
    started?: boolean;
    completed?: boolean;
  }) {
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

  async startFullPipeline(
    videoId: string,
    dto: RunFullPipelineDto,
  ): Promise<RunFullPipelineResponse> {
    const video = await this.findById(videoId);
    const datasetId = String(video.datasetId);

    if (!datasetId) {
      throw new BadRequestException(`Video ${videoId} does not have datasetId`);
    }

    const pipelineRunId = randomUUID();

    const config = {
      sampleFps: dto.sampleFps ?? 2,
      blurThreshold: dto.blurThreshold ?? 100,
      noiseThreshold: dto.noiseThreshold ?? 25,
      runDense: dto.runDense ?? true,
      mode: dto.mode ?? 'balanced',
      outputRawFolder: 'raw_images',
      outputProcessedFolder: 'processed_images',
      outputMaskFolder: 'masks',
    };

    await this.databaseService.query(
      `
    INSERT INTO pipeline_runs (
      id,
      dataset_id,
      video_id,
      pipeline_type,
      status,
      progress,
      current_stage,
      config,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
    `,
      [
        pipelineRunId,
        datasetId,
        videoId,
        'processed',
        'pending',
        0,
        'queued',
        JSON.stringify(config),
      ],
    );

    await this.createFullPipelineSteps(pipelineRunId);

    await this.databaseService.query(
      `
      UPDATE videos
      SET status = 'processing'
      WHERE id = $1
      `,
      [videoId],
    );

    await this.databaseService.query(
      `
      UPDATE datasets
      SET status = 'processing'
      WHERE id = $1
      `,
      [datasetId],
    );

    const job = await this.fullPipelineQueueService.addRunFullPipelineJob({
      videoId,
      pipelineRunId,
      dto,
    });

    return {
      message: 'Pipeline queued',
      videoId,
      pipelineRunId,
      jobId: String(job.id),
    };
  }

  private async createFullPipelineSteps(pipelineRunId: string) {
    const steps: [string, string][] = [
      ['frame_extract', 'Extract frames from video'],
      ['preprocessing', 'Filter blur/noise frames'],
      ['mask_generation', 'Generate dynamic masks'],
      ['opensfm_raw', 'Run OpenSfM raw flow'],
      ['opensfm_processed', 'Run OpenSfM processed flow'],
      ['evaluation', 'Compare reconstruction quality'],
    ];

    for (const [key, name] of steps) {
      await this.databaseService.query(
        `
      INSERT INTO pipeline_steps (
        pipeline_run_id,
        step_key,
        step_name,
        status,
        progress,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'pending', 0, NOW(), NOW())
      ON CONFLICT(pipeline_run_id, step_key) DO NOTHING
      `,
        [pipelineRunId, key, name],
      );
    }
  }

  // private async updatePipelineRunProgress(
  //   pipelineRunId: string,
  //   status: string,
  //   progress: number,
  // ) {
  //   await this.dbQuery(
  //     `
  //     UPDATE pipeline_runs
  //     SET status = $2,
  //         progress = $3,
  //         updated_at = NOW()
  //     WHERE id = $1
  //   `,
  //     [pipelineRunId, status, progress],
  //   );
  // }

  async getPipelineRunStatus(
    pipelineRunId: string,
  ): Promise<PipelineRunStatusResponse> {
    const result = await this.databaseService.query(
      `
    SELECT
      id,
      video_id AS "videoId",
      dataset_id AS "datasetId",
      status,
      progress,
      current_stage AS "currentStage",
      config,
      result,
      error_message AS "errorMessage",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      started_at AS "startedAt",
      completed_at AS "completedAt"
    FROM pipeline_runs
    WHERE id = $1
    LIMIT 1
    `,
      [pipelineRunId],
    );

    const run = result.rows[0];

    if (!run) {
      throw new NotFoundException(`Pipeline run ${pipelineRunId} not found`);
    }

    return {
      id: run.id,
      videoId: run.videoId ?? null,
      datasetId: run.datasetId ?? null,
      status: run.status,
      progress: run.progress ?? null,
      currentStage: run.currentStage ?? null,
      config: run.config ?? null,
      result: run.result ?? null,
      errorMessage: run.errorMessage ?? null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
    };
  }
  async getProjectById(projectId: string) {
    const result = await this.databaseService.query(
      `
    SELECT
      p.id,
      p.name,
      p.description,
      p.visibility,
      p.status,
      p.created_at AS "createdAt",
      p.updated_at AS "updatedAt",
      d.id AS "datasetId",
      v.id AS "videoId",
      v.original_name AS "videoName"
    FROM projects p
    LEFT JOIN datasets d ON d.project_id = p.id
    LEFT JOIN videos v ON v.dataset_id = d.id
    WHERE p.id = $1
    ORDER BY v.created_at DESC NULLS LAST
    LIMIT 1
    `,
      [projectId],
    );

    if (!result.rows[0]) {
      throw new NotFoundException('Project not found');
    }

    return result.rows[0];
  }
  async getLatestProjectPipeline(projectId: string) {
    const result = await this.databaseService.query(
      `
    SELECT
      pr.id,
      pr.video_id AS "videoId",
      pr.dataset_id AS "datasetId",
      pr.status,
      pr.progress,
      pr.current_stage AS "currentStage",
      pr.config,
      pr.result,
      pr.error_message AS "errorMessage",
      pr.created_at AS "createdAt",
      pr.updated_at AS "updatedAt",
      pr.started_at AS "startedAt",
      pr.completed_at AS "completedAt"
    FROM pipeline_runs pr
    JOIN datasets d ON d.id = pr.dataset_id
    WHERE d.project_id = $1
    ORDER BY pr.created_at DESC
    LIMIT 1
    `,
      [projectId],
    );

    return result.rows[0] ?? null;
  }
  async getProjectAssets(projectId: string) {
    const project = await this.getProjectById(projectId);

    const videoResult = await this.databaseService.query(
      `
    SELECT
      v.id,
      v.dataset_id AS "datasetId",
      COALESCE(v.original_name, sf.original_name) AS "originalName",
      COALESCE(v.mime_type, sf.mime_type) AS "mimeType",
      COALESCE(v.size_bytes, sf.size_bytes) AS "sizeBytes",
      sf.bucket,
      sf.object_path AS "objectPath"
    FROM datasets d
    JOIN videos v
      ON v.dataset_id = d.id
    LEFT JOIN storage_files sf
      ON sf.id = v.storage_file_id
    WHERE d.project_id = $1
    ORDER BY v.created_at DESC NULLS LAST
    LIMIT 1
    `,
      [projectId],
    );

    const videoRow = videoResult.rows[0];

    const video = videoRow
      ? {
          id: videoRow.id,
          datasetId: videoRow.datasetId,
          originalName: videoRow.originalName ?? null,
          mimeType: videoRow.mimeType ?? null,
          sizeBytes: videoRow.sizeBytes ? Number(videoRow.sizeBytes) : null,
          url: buildSupabasePublicUrl({
            bucket: videoRow.bucket,
            objectPath: videoRow.objectPath,
          }),
        }
      : null;

    const videoId = video?.id ?? project.videoId;

    if (!videoId) {
      return {
        video: null,
        rawImages: [],
        processedImages: [],
        masks: [],
        folders: {
          rawImages: [],
          processedImages: [],
          masks: [],
        },
      };
    }

    const assets = await this.getVideoAssets(videoId);

    return {
      ...assets,
      video,
    };
  }
  async listVideos(query: {
    datasetId?: string;
    projectId?: string;
    userId?: string;
    page?: string;
    limit?: string;
  }) {
    const page = parsePage(query.page);
    const limit = parseLimit(query.limit);
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.datasetId) {
      values.push(query.datasetId);
      conditions.push(`v.dataset_id = $${values.length}`);
    }

    if (query.projectId) {
      values.push(query.projectId);
      conditions.push(`d.project_id = $${values.length}`);
    }

    if (query.userId) {
      values.push(query.userId);
      conditions.push(`p.user_id = $${values.length}`);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const countResult = await this.databaseService.query(
      `
    SELECT COUNT(*)::int AS total
    FROM videos v
    LEFT JOIN datasets d ON d.id = v.dataset_id
    LEFT JOIN projects p ON p.id = d.project_id
    ${whereClause}
    `,
      values,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);

    values.push(limit);
    values.push(offset);

    const limitIndex = values.length - 1;
    const offsetIndex = values.length;

    const result = await this.databaseService.query(
      `
    SELECT
      v.id,
      v.dataset_id AS "datasetId",
      v.file_name AS "fileName",
      v.status,
      v.storage_file_id AS "storageFileId",
      v.created_at AS "createdAt",
      v.updated_at AS "updatedAt"
    FROM videos v
    LEFT JOIN datasets d ON d.id = v.dataset_id
    LEFT JOIN projects p ON p.id = d.project_id
    ${whereClause}
    ORDER BY v.created_at DESC
    LIMIT $${limitIndex}
    OFFSET $${offsetIndex}
    `,
      values,
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items: result.rows,
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }
}
