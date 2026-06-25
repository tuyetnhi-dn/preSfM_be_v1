import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { calculateImageQuality } from './image-preprocessor';

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
  constructor(private readonly configService: ConfigService) {}

  async processRawFrames(input: ProcessRawFramesInput): Promise<{
    images: ProcessRawFrameResult[];
    total: number;
    selectedCount: number;
    rejectedCount: number;
  }> {
    const blurThreshold = Number(input.config?.blurThreshold ?? 250);
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

    const selectedCount = results.filter(
      (item) =>
        item.isSelected &&
        item.processedStorageFileId &&
        item.maskStorageFileId,
    ).length;

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
    const rawFile = await this.downloadStorageFile(
      input.frame.rawStorageFileId,
    );

    const quality = await calculateImageQuality(rawFile.buffer);

    let rejectedReason: string | null = null;

    if (quality.blurScore < input.blurThreshold) {
      rejectedReason = 'blur';
    } else if (quality.noiseScore > input.noiseThreshold) {
      rejectedReason = 'noise';
    }

    if (rejectedReason) {
      return {
        frameId: input.frame.frameId,
        frameIndex: input.frame.frameIndex,
        blurScore: quality.blurScore,
        noiseScore: quality.noiseScore,
        isSelected: false,
        rejectedReason,
        processedStorageFileId: null,
        maskStorageFileId: null,
      };
    }

    const imageName = `frame_${String(input.frame.frameIndex + 1).padStart(
      6,
      '0',
    )}`;

    let maskBuffer = await this.callSegmentationModel({
      imageBuffer: rawFile.buffer,
      imageName,
      mimeType: rawFile.mimeType,
      extension: rawFile.extension,
    });

    if (!maskBuffer) {
      maskBuffer = await this.createEmptyModelMask(rawFile.buffer);
    }

    const processedPath = this.buildObjectPath({
      datasetId: input.datasetId,
      videoId: input.videoId,
      folder: input.outputProcessedFolder,
      frameIndex: input.frame.frameIndex,
      extension: rawFile.extension,
    });

    const uploadedProcessed = await this.uploadBufferToStorage({
      buffer: rawFile.buffer,
      filename: `${imageName}.${rawFile.extension}`,
      mimeType: rawFile.mimeType,
      bucket: this.defaultBucket(),
      objectPath: processedPath,
      datasetId: input.datasetId,
    });

    const maskPath = this.buildObjectPath({
      datasetId: input.datasetId,
      videoId: input.videoId,
      folder: input.outputMaskFolder,
      frameIndex: input.frame.frameIndex,
      extension: 'png',
    });

    const uploadedMask = await this.uploadBufferToStorage({
      buffer: maskBuffer,
      filename: `${imageName}.png`,
      mimeType: 'image/png',
      bucket: this.defaultBucket(),
      objectPath: maskPath,
      datasetId: input.datasetId,
    });

    return {
      frameId: input.frame.frameId,
      frameIndex: input.frame.frameIndex,
      blurScore: quality.blurScore,
      noiseScore: quality.noiseScore,
      isSelected: true,
      rejectedReason: null,
      processedStorageFileId: uploadedProcessed.id,
      maskStorageFileId: uploadedMask.id,
    };
  }

  private async callSegmentationModel(input: {
    imageBuffer: Buffer;
    imageName: string;
    mimeType: string;
    extension: string;
  }): Promise<Buffer | null> {
    const modelServiceUrl = this.configService.get<string>(
      'SEGMENTATION_SERVICE_URL',
      'http://segmentation-service:5000',
    );

    const formData = new FormData();

    formData.append(
      'image',
      new Blob([new Uint8Array(input.imageBuffer)], {
        type: input.mimeType,
      }),
      `${input.imageName}.${input.extension}`,
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

    if (arrayBuffer.byteLength === 0) {
      return null;
    }

    return Buffer.from(arrayBuffer);
  }

  private async createEmptyModelMask(imageBuffer: Buffer): Promise<Buffer> {
    const metadata = await sharp(imageBuffer).metadata();

    if (!metadata.width || !metadata.height) {
      throw new InternalServerErrorException(
        'Cannot create empty mask because image size is unknown',
      );
    }

    return sharp({
      create: {
        width: metadata.width,
        height: metadata.height,
        channels: 3,
        background: {
          r: 0,
          g: 0,
          b: 0,
        },
      },
    })
      .png()
      .toBuffer();
  }

  private async downloadStorageFile(storageFileId: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    extension: string;
  }> {
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

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();

    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: contentType,
      extension: this.extensionFromMimeType(contentType),
    };
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
      new Blob([new Uint8Array(input.buffer)], {
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
    extension: string;
  }) {
    const frameName = `frame_${String(input.frameIndex + 1).padStart(
      6,
      '0',
    )}.${input.extension}`;

    return `datasets/${input.datasetId}/videos/${input.videoId}/${input.folder}/${frameName}`;
  }

  private extensionFromMimeType(mimeType: string): string {
    const value = mimeType.toLowerCase();

    if (value.includes('png')) return 'png';
    if (value.includes('webp')) return 'webp';
    if (value.includes('bmp')) return 'bmp';
    if (value.includes('tiff')) return 'tiff';
    if (value.includes('jpeg')) return 'jpg';
    if (value.includes('jpg')) return 'jpg';

    return 'jpg';
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
