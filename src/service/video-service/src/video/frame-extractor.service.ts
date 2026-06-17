import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../common/database/database.service';

export type ExtractInput = {
  pipelineRunId: string;
  pipelineType: string;
  datasetId: string;
  videoId: string;
  sampleFps?: number;
  videoStorageFileId: string;
  videoStoragePath: string;
  videoStorageUrl: string | null;
  videoBucket: string;
  videoObjectPath: string;
  config: Record<string, unknown>;
};

type ExtractedFrame = {
  frameId: string;
  frameIndex: number;
  timestampMs: number;
  width: number | null;
  height: number | null;
  rawStorageFileId: string;
};

@Injectable()
export class FrameExtractorService {
  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {}
  private async insertRawFrame(input: {
    datasetId: string;
    videoId: string;
    frameIndex: number;
    timestampMs: number;
    width: number | null;
    height: number | null;
    rawStorageFileId: string;
  }) {
    const result = await this.databaseService.query(
      `
    INSERT INTO frames (
      dataset_id,
      video_id,
      frame_index,
      timestamp_ms,
      width,
      height,
      raw_storage_file_id,
      is_selected,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW(), NOW())
    RETURNING id
    `,
      [
        input.datasetId,
        input.videoId,
        input.frameIndex,
        input.timestampMs,
        input.width,
        input.height,
        input.rawStorageFileId,
      ],
    );

    return String(result.rows[0].id);
  }
  private async downloadStorageFileById(
    storageFileId: string,
    outputPath: string,
  ) {
    if (
      !storageFileId ||
      storageFileId === 'undefined' ||
      storageFileId === 'null'
    ) {
      throw new BadRequestException('Video storage file id is missing');
    }

    const response = await fetch(
      `${this.storageServiceUrl()}/storage/files/${encodeURIComponent(
        storageFileId,
      )}/download`,
      {
        method: 'GET',
      },
    );

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Cannot download video by storage file id: ${await response.text()}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
  }

  async extract(input: ExtractInput): Promise<{ frames: ExtractedFrame[] }> {
    if (!input.videoBucket || !input.videoObjectPath) {
      throw new BadRequestException('Video bucket or object path is missing');
    }

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `presfm-${input.pipelineRunId}-`),
    );

    const videoPath = path.join(tempRoot, `input-${randomUUID()}.mp4`);
    const outputDir = path.join(tempRoot, 'raw_frames');

    try {
      await fs.mkdir(outputDir, { recursive: true });

      const sampleFps = this.toNumber(input.config.sampleFps, 2);
      const outputRawFolder = this.toString(
        input.config.outputRawFolder,
        'raw_images',
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await this.downloadStorageFileById(input.videoStorageFileId, videoPath);

      const metadata = await this.getVideoMetadata(videoPath);

      await this.runCommand('ffmpeg', [
        '-y',
        '-i',
        videoPath,
        '-vf',
        `fps=${sampleFps}`,
        '-q:v',
        '2',
        path.join(outputDir, 'frame_%06d.jpg'),
      ]);

      const files = (await fs.readdir(outputDir))
        .filter((file) => file.toLowerCase().endsWith('.jpg'))
        .sort();

      if (files.length === 0) {
        throw new InternalServerErrorException('No frames were extracted');
      }

      const frameBucket = this.configService.get<string>(
        'SUPABASE_DEFAULT_BUCKET',
        'presfm',
      );

      const frames: ExtractedFrame[] = [];

      for (let index = 0; index < files.length; index++) {
        const filename = files[index];
        const filePath = path.join(outputDir, filename);
        const buffer = await fs.readFile(filePath);

        const objectPath = `datasets/${input.datasetId}/videos/${input.videoId}/${outputRawFolder}/${filename}`;

        const storageFile = await this.uploadFrameToStorage({
          buffer,
          filename,
          bucket: frameBucket,
          objectPath,
          datasetId: input.datasetId,
        });

        const timestampMs = Math.round((index / sampleFps) * 1000);

        const frameId = await this.insertRawFrame({
          datasetId: input.datasetId,
          videoId: input.videoId,
          frameIndex: index,
          timestampMs,
          width: metadata.width,
          height: metadata.height,
          rawStorageFileId: storageFile.id,
        });

        frames.push({
          frameId,
          frameIndex: index,
          timestampMs,
          width: metadata.width,
          height: metadata.height,
          rawStorageFileId: storageFile.id,
        });
      }

      await this.databaseService.query(
        `
  UPDATE datasets
  SET raw_frame_count = $2,
      selected_frame_count = $2,
      updated_at = NOW()
  WHERE id = $1
  `,
        [input.datasetId, frames.length],
      );

      return { frames };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async createSignedUrl(bucket: string, objectPath: string) {
    const query = `?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(
      objectPath,
    )}&expiresIn=3600`;

    const response = await fetch(
      `${this.storageServiceUrl()}/storage/signed-url${query}`,
      {
        method: 'GET',
      },
    );

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Cannot create signed URL: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as Record<string, any>;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const signedUrl =
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      data.signedUrl ?? data.url ?? data.data?.signedUrl ?? data.data?.url;

    if (!signedUrl) {
      throw new InternalServerErrorException('Signed URL not found');
    }

    return String(signedUrl);
  }

  private async downloadFile(url: string, outputPath: string) {
    const response = await fetch(url);

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Cannot download video: ${await response.text()}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
  }

  private async uploadFrameToStorage(input: {
    buffer: Buffer;
    filename: string;
    bucket: string;
    objectPath: string;
    datasetId: string;
  }) {
    const formData = new FormData();

    formData.append(
      'file',
      new Blob([input.buffer as unknown as BlobPart], {
        type: 'image/jpeg',
      }),
      input.filename,
    );

    formData.append('bucket', input.bucket);
    formData.append('path', input.objectPath);
    formData.append('datasetId', input.datasetId);

    const response = await fetch(`${this.storageServiceUrl()}/storage/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Cannot upload extracted frame: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as Record<string, any>;

    if (!data.id) {
      throw new InternalServerErrorException(
        'Storage service did not return storage file id',
      );
    }

    return data as { id: string };
  }

  private async getVideoMetadata(videoPath: string) {
    try {
      const stdout = await this.runCommandWithOutput('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        videoPath,
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const data = JSON.parse(stdout);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const stream = data.streams?.[0];

      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        width: this.toNullableNumber(stream?.width),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        height: this.toNullableNumber(stream?.height),
      };
    } catch {
      return {
        width: null,
        height: null,
      };
    }
  }

  private runCommand(command: string, args: string[]) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args);

      let stderr = '';

      child.stderr.on('data', (data) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        stderr += data.toString();
      });

      child.on('error', (error) => {
        reject(
          new InternalServerErrorException(
            `${command} not found or failed: ${error.message}`,
          ),
        );
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new InternalServerErrorException(
            `${command} failed with code ${code}: ${stderr}`,
          ),
        );
      });
    });
  }

  private runCommandWithOutput(command: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        stderr += data.toString();
      });

      child.on('error', (error) => {
        reject(
          new InternalServerErrorException(
            `${command} not found or failed: ${error.message}`,
          ),
        );
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        reject(
          new InternalServerErrorException(
            `${command} failed with code ${code}: ${stderr}`,
          ),
        );
      });
    });
  }

  private storageServiceUrl() {
    return this.configService.get<string>(
      'STORAGE_SERVICE_URL',
      'http://storage-service:8004',
    );
  }

  private toNumber(value: unknown, fallback: number) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0
      ? numberValue
      : fallback;
  }

  private toNullableNumber(value: unknown) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  private toString(value: unknown, fallback: string) {
    return typeof value === 'string' && value.trim() ? value : fallback;
  }
}
