/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, InternalServerErrorException } from '@nestjs/common';

type AssetFile = {
  storageFileId: string;
  bucket?: string | null;
  path?: string | null;
  url?: string | null;
};

type FrameAssetItem = {
  frameIndex: number;
  raw?: AssetFile | null;
  processed?: AssetFile | null;
  mask?: AssetFile | null;
};

type VideoAssets = {
  rawImages: FrameAssetItem[];
  processedImages: FrameAssetItem[];
  masks: FrameAssetItem[];
};

@Injectable()
export class OpenSfMComparisonService {
  async compare(input: {
    datasetId: string;
    videoId: string;
    assets: VideoAssets;
    runDense: boolean;
  }) {
    const rawImages = input.assets.rawImages
      .filter((item) => item.raw?.storageFileId)
      .map((item) => ({
        frameIndex: item.frameIndex,
        imageStorageFileId: String(item.raw?.storageFileId),
      }));

    const maskByFrameIndex = new Map<number, FrameAssetItem>();

    for (const item of input.assets.masks) {
      maskByFrameIndex.set(item.frameIndex, item);
    }

    const processedPairs = input.assets.processedImages.map((item) => {
      const mask = maskByFrameIndex.get(item.frameIndex);

      if (!item.processed?.storageFileId) {
        throw new InternalServerErrorException(
          `Missing processed image at frame ${item.frameIndex}`,
        );
      }

      if (!mask?.mask?.storageFileId) {
        throw new InternalServerErrorException(
          `Missing mask at frame ${item.frameIndex}`,
        );
      }

      return {
        frameIndex: item.frameIndex,
        imageStorageFileId: item.processed.storageFileId,
        maskStorageFileId: mask.mask.storageFileId,
      };
    });

    if (rawImages.length === 0) {
      throw new InternalServerErrorException('Raw images are empty');
    }

    if (processedPairs.length === 0) {
      throw new InternalServerErrorException('Processed images are empty');
    }

    if (input.assets.processedImages.length !== input.assets.masks.length) {
      throw new InternalServerErrorException(
        'processedImages and masks must have the same length',
      );
    }

    const opensfmServiceUrl =
      process.env.OPENSFM_SERVICE_URL ?? 'http://opensfm-service:8005';

    const response = await fetch(`${opensfmServiceUrl}/opensfm/compare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoId: input.videoId,
        datasetId: input.datasetId,
        rawImages,
        processedPairs,
        runDense: input.runDense,
      }),
    });

    if (!response.ok) {
      throw new InternalServerErrorException(
        `OpenSfM service error: ${await response.text()}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const payload = await response.json();
    console.log('OpenSfM compare response keys:', Object.keys(payload ?? {}));
    console.log(
      'Raw reconstruction exists:',
      Boolean(payload?.rawFlow?.reconstruction),
    );
    console.log(
      'Processed reconstruction exists:',
      Boolean(payload?.processedFlow?.reconstruction),
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return payload;
  }
}
