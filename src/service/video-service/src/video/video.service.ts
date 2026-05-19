import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../common/database/database.service';

type UploadBody = {
  datasetId?: string;
  uploadedBy?: string;
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

@Injectable()
export class VideoService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  async upload(file: Express.Multer.File, body: UploadBody) {
    if (!file) {
      throw new BadRequestException('Video file is required');
    }
    if (!body.datasetId) {
      throw new BadRequestException('datasetId is required');
    }
    if (!this.isAllowedVideo(file.mimetype, file.originalname)) {
      throw new BadRequestException('Unsupported video format');
    }
    const dataset = await this.getDataset(body.datasetId);
    const extension = this.fileExtension(file.originalname);
    const objectPath = `projects/${dataset.project_id}/datasets/${body.datasetId}/videos/${randomUUID()}${extension}`;
    const storageFile = await this.uploadToStorage(file, {
      bucket: this.configService.get<string>('VIDEO_BUCKET', 'videos'),
      path: objectPath,
      uploadedBy: body.uploadedBy,
      projectId: dataset.project_id,
      datasetId: body.datasetId,
    });
    const result = await this.databaseService.query(
      `INSERT INTO videos(dataset_id, storage_file_id, original_name, mime_type, size_bytes, status)
       VALUES ($1, $2, $3, $4, $5, 'uploaded')
       RETURNING id, dataset_id, storage_file_id, original_name, mime_type, size_bytes, status, created_at`,
      [body.datasetId, storageFile.id, file.originalname, file.mimetype, file.size],
    );
    await this.databaseService.query(`UPDATE datasets SET status = 'ready' WHERE id = $1`, [body.datasetId]);
    return {
      ...this.mapVideo(result.rows[0]),
      storageFile,
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

  async createFrameExtractionPipeline(id: string, body: { sampleFps?: number; config?: Record<string, unknown> }) {
    const video = await this.findById(id);
    const pipeline = await this.databaseService.query(
      `INSERT INTO pipeline_runs(dataset_id, video_id, status, progress, config)
       VALUES ($1, $2, 'pending', 0, $3::jsonb)
       RETURNING id, dataset_id, video_id, status, progress, config, created_at`,
      [video.datasetId, id, JSON.stringify({ sampleFps: body.sampleFps || 2, ...(body.config || {}) })],
    );
    const steps = [
      ['frame_extract', 'Extract frames from video'],
      ['opensfm_raw', 'Run OpenSfM with raw frames'],
      ['preprocessing', 'Filter frames and create dynamic masks'],
      ['opensfm_processed', 'Run OpenSfM with processed frames'],
      ['evaluation', 'Compare raw and processed point clouds'],
    ];
    for (const [key, name] of steps) {
      await this.databaseService.query(
        `INSERT INTO pipeline_steps(pipeline_run_id, step_key, step_name)
         VALUES ($1, $2, $3)
         ON CONFLICT(pipeline_run_id, step_key) DO NOTHING`,
        [pipeline.rows[0].id, key, name],
      );
    }
    await this.databaseService.query(`UPDATE videos SET status = 'frame_extracting' WHERE id = $1`, [id]);
    return pipeline.rows[0];
  }

  async delete(id: string) {
    const video = await this.findById(id);
    await this.databaseService.query(`DELETE FROM videos WHERE id = $1`, [id]);
    return { success: true, deletedVideoId: video.id };
  }

  private async getDataset(datasetId: string) {
    const result = await this.databaseService.query(
      `SELECT id, project_id, status FROM datasets WHERE id = $1`,
      [datasetId],
    );
    const dataset = result.rows[0];
    if (!dataset) {
      throw new NotFoundException('Dataset not found');
    }
    return dataset;
  }

  private async uploadToStorage(file: Express.Multer.File, input: { bucket: string; path: string; uploadedBy?: string; projectId?: string; datasetId?: string }) {
    const formData = new FormData();
    formData.append('file', new Blob([file.buffer as unknown as BlobPart], { type: file.mimetype }), file.originalname);
    formData.append('bucket', input.bucket);
    formData.append('path', input.path);
    if (input.uploadedBy) formData.append('uploadedBy', input.uploadedBy);
    if (input.projectId) formData.append('projectId', input.projectId);
    if (input.datasetId) formData.append('datasetId', input.datasetId);
    const response = await fetch(`${this.storageServiceUrl()}/storage/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      throw new BadRequestException(await response.text());
    }
    return await response.json() as StorageUploadResponse;
  }

  private storageServiceUrl() {
    return this.configService.get<string>('STORAGE_SERVICE_URL', 'http://storage-service:3004');
  }

  private isAllowedVideo(mimeType: string, filename: string) {
    const lower = filename.toLowerCase();
    return mimeType.startsWith('video/') || lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.avi') || lower.endsWith('.mkv');
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
}
