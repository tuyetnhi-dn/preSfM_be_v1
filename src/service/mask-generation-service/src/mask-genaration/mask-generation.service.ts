import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs/promises';
import { resizeWithPadding, TARGET_SIZE } from './image-preprocessor';
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

@Injectable()
export class MaskGenerationService {
  private readonly logger = new Logger(MaskGenerationService.name);

  constructor(private readonly configService: ConfigService) {}

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
}
