import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  calculateImageQuality,
  resizeWithPadding,
  TARGET_SIZE,
} from './image-preprocessor';
import sharp from 'sharp';

export type GenerateMaskJobInput = {
  pipelineRunId: string;
  imagesPaths: string[];
  outputMasksDir: string;
};

export type MaskResult = {
  imageName: string;
  maskPath: string;
  skipped: boolean;
};

export type RawFrameInput = {
  frameId: string;
  frameIndex: number;
  rawStorageFileId: string;
};

export type ProcessRawFramesInput = {
  pipelineRunId: string;
  datasetId: string;
  videoId: string;
  frames: RawFrameInput[];
  config?: {
    blurThreshold?: number;
    noiseThreshold?: number;
    outputProcessedFolder?: string;
    outputMaskFolder?: string;
  };
};

export type ProcessRawFrameResult = {
  frameId: string;
  frameIndex: number;
  blurScore: number | null;
  noiseScore: number | null;
  isSelected: boolean;
  rejectedReason: string | null;
  processedStorageFileId: string | null;
  maskStorageFileId: string | null;
};

@Injectable()
export class MaskGenerationService {
  private readonly logger = new Logger(MaskGenerationService.name);

  constructor(private readonly configService: ConfigService) {}

  async processRawFrames(input: ProcessRawFramesInput): Promise<{
    images: ProcessRawFrameResult[];
    total: number;
    selectedCount: number;
    rejectedCount: number;
  }> {
    const blurThreshold = Number(input.config?.blurThreshold ?? 100);
    const noiseThreshold = Number(input.config?.noiseThreshold ?? 25);

    const outputProcessedFolder =
      input.config?.outputProcessedFolder ?? 'processed_images';

    const outputMaskFolder = input.config?.outputMaskFolder ?? 'masks';

    const results: ProcessRawFrameResult[] = [];

    for (const frame of input.frames) {
      const result = await this.processOneRawFrame({
        datasetId: input.datasetId,
        videoId: input.videoId,
        frame,
        blurThreshold,
        noiseThreshold,
        outputProcessedFolder,
        outputMaskFolder,
      });

      results.push(result);
    }

    const selectedCount = results.filter((item) => item.isSelected).length;
    const rejectedCount = results.length - selectedCount;

    return {
      images: results,
      total: results.length,
      selectedCount,
      rejectedCount,
    };
  }

  private async processOneRawFrame(input: {
    datasetId: string;
    videoId: string;
    frame: RawFrameInput;
    blurThreshold: number;
    noiseThreshold: number;
    outputProcessedFolder: string;
    outputMaskFolder: string;
  }): Promise<ProcessRawFrameResult> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const rawBuffer = await this.downloadStorageFile(
      input.frame.rawStorageFileId,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const quality = await calculateImageQuality(rawBuffer);

    let rejectedReason: string | null = null;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (quality.blurScore < input.blurThreshold) {
      rejectedReason = 'blur';
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    } else if (quality.noiseScore > input.noiseThreshold) {
      rejectedReason = 'noise';
    }

    if (rejectedReason) {
      return {
        frameId: input.frame.frameId,
        frameIndex: input.frame.frameIndex,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        blurScore: quality.blurScore,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        noiseScore: quality.noiseScore,
        isSelected: false,
        rejectedReason,
        processedStorageFileId: null,
        maskStorageFileId: null,
      };
    }

    const resized = await resizeWithPadding(rawBuffer);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const processedPath = this.buildObjectPath({
      datasetId: input.datasetId,
      videoId: input.videoId,
      folder: input.outputProcessedFolder,
      frameIndex: input.frame.frameIndex,
      extension: 'png',
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const uploadedProcessed = await this.uploadBufferToStorage({
      buffer: resized.buffer,
      filename: `frame_${String(input.frame.frameIndex + 1).padStart(6, '0')}.png`,
      mimeType: 'image/png',
      bucket: this.defaultBucket(),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      objectPath: processedPath,
      datasetId: input.datasetId,
    });

    const maskBuffer = await this.callSegmentationModel(
      resized.buffer,
      `frame_${String(input.frame.frameIndex + 1).padStart(6, '0')}`,
    );

    let maskStorageFileId: string | null = null;

    if (maskBuffer) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const maskPath = this.buildObjectPath({
        datasetId: input.datasetId,
        videoId: input.videoId,
        folder: input.outputMaskFolder,
        frameIndex: input.frame.frameIndex,
        extension: 'png',
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const uploadedMask = await this.uploadBufferToStorage({
        buffer: maskBuffer,
        filename: `frame_${String(input.frame.frameIndex + 1).padStart(6, '0')}.png`,
        mimeType: 'image/png',
        bucket: this.defaultBucket(),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        objectPath: maskPath,
        datasetId: input.datasetId,
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      maskStorageFileId = uploadedMask.id;
    }

    return {
      frameId: input.frame.frameId,
      frameIndex: input.frame.frameIndex,
      blurScore: quality.blurScore,
      noiseScore: quality.noiseScore,
      isSelected: true,
      rejectedReason: null,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      processedStorageFileId: uploadedProcessed.id,
      maskStorageFileId,
    };
  }

  async generateMasks(input: GenerateMaskJobInput): Promise<MaskResult[]> {
    await fs.mkdir(input.outputMasksDir, { recursive: true });

    const results: MaskResult[] = [];

    for (const imagePath of input.imagesPaths) {
      const imageName = path.basename(imagePath, path.extname(imagePath));

      try {
        const result = await this.processOne(
          imagePath,
          imageName,
          input.outputMasksDir,
        );
        results.push(result);
      } catch (err) {
        this.logger.error(
          `Failed to generate mask for ${imageName}: ${(err as Error).message}`,
        );
        results.push({
          imageName,
          maskPath: '',
          skipped: true,
        });
      }
    }

    return results;
  }

  private async processOne(
    imagePath: string,
    imageName: string,
    outputDir: string,
  ): Promise<MaskResult> {
    const rawBuffer = await fs.readFile(imagePath);

    const { buffer: resizedBuffer } = await resizeWithPadding(rawBuffer);

    const maskBuffer = await this.callSegmentationModel(
      resizedBuffer,
      imageName,
    );

    if (!maskBuffer) {
      const emptyMask = await this.createEmptyMask();
      const maskPath = path.join(outputDir, `${imageName}.png`);
      await fs.writeFile(maskPath, emptyMask);
      return { imageName, maskPath, skipped: true };
    }

    const maskPath = path.join(outputDir, `${imageName}.png`);
    await fs.writeFile(maskPath, maskBuffer);

    return { imageName, maskPath, skipped: false };
  }

  private async callSegmentationModel(
    imageBuffer: Buffer,
    imageName: string,
  ): Promise<Buffer | null> {
    const modelServiceUrl = this.configService.get<string>(
      'SEGMENTATION_SERVICE_URL',
      'http://segmentation-service:5000',
    );

    const formData = new FormData();
    formData.append(
      'image',
      new Blob([imageBuffer as unknown as BlobPart], { type: 'image/png' }),
      `${imageName}.png`,
    );

    const response = await fetch(`${modelServiceUrl}/segment`, {
      method: 'POST',
      body: formData,
    });

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Segmentation model error: ${await response.text()}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async createEmptyMask(): Promise<Buffer> {
    const empty = Buffer.alloc(TARGET_SIZE * TARGET_SIZE, 0);
    return await sharp(empty, {
      raw: { width: TARGET_SIZE, height: TARGET_SIZE, channels: 1 },
    })
      .png()
      .toBuffer();
  }
  private async downloadStorageFile(storageFileId: string): Promise<Buffer> {
    if (!storageFileId) {
      throw new InternalServerErrorException('Missing storage file id');
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
        `Cannot download raw frame: ${await response.text()}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();

    return Buffer.from(arrayBuffer);
  }

  private async uploadBufferToStorage(input: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    bucket: string;
    objectPath: string;
    datasetId: string;
  }): Promise<{ id: string }> {
    const formData = new FormData();

    formData.append(
      'file',
      new Blob([input.buffer as unknown as BlobPart], {
        type: input.mimeType,
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
        `Cannot upload image to storage: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!data.id) {
      throw new InternalServerErrorException(
        'Storage service did not return file id',
      );
    }

    return {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      id: String(data.id),
    };
  }

  private buildObjectPath(input: {
    datasetId: string;
    videoId: string;
    folder: string;
    frameIndex: number;
    extension: 'png' | 'jpg';
  }) {
    const frameName = `frame_${String(input.frameIndex + 1).padStart(
      6,
      '0',
    )}.${input.extension}`;

    return `datasets/${input.datasetId}/videos/${input.videoId}/${input.folder}/${frameName}`;
  }

  private storageServiceUrl() {
    return this.configService.get<string>(
      'STORAGE_SERVICE_URL',
      'http://storage-service:8004',
    );
  }

  private defaultBucket() {
    return this.configService.get<string>('SUPABASE_DEFAULT_BUCKET', 'presfm');
  }
}
