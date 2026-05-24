import sharp from 'sharp';

export const TARGET_SIZE = 768;

export type ResizeResult = {
  buffer: Buffer;
  originalWidth: number;
  originalHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  padTop: number;
  padLeft: number;
};

export type QualityResult = {
  blurScore: number;
  noiseScore: number;
};

export async function resizeWithPadding(
  inputBuffer: Buffer,
): Promise<ResizeResult> {
  const meta = await sharp(inputBuffer).metadata();

  if (meta.width == null || meta.height == null) {
    throw new Error('Image metadata missing width or height');
  }

  const originalWidth = meta.width;
  const originalHeight = meta.height;

  const scale = TARGET_SIZE / Math.max(originalWidth, originalHeight);
  const scaledWidth = Math.round(originalWidth * scale);
  const scaledHeight = Math.round(originalHeight * scale);

  const padTop = Math.floor((TARGET_SIZE - scaledHeight) / 2);
  const padLeft = Math.floor((TARGET_SIZE - scaledWidth) / 2);

  const buffer = await sharp(inputBuffer)
    .resize(scaledWidth, scaledHeight, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .extend({
      top: padTop,
      bottom: TARGET_SIZE - scaledHeight - padTop,
      left: padLeft,
      right: TARGET_SIZE - scaledWidth - padLeft,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toBuffer();

  return {
    buffer,
    originalWidth,
    originalHeight,
    scaledWidth,
    scaledHeight,
    padTop,
    padLeft,
  };
}

export async function calculateImageQuality(
  inputBuffer: Buffer,
): Promise<QualityResult> {
  const { data, info } = await sharp(inputBuffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const pixels = new Uint8Array(data);

  return {
    blurScore: calculateBlurScore(pixels, width, height),
    noiseScore: calculateNoiseScore(pixels, width, height),
  };
}

function calculateBlurScore(
  pixels: Uint8Array,
  width: number,
  height: number,
): number {
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;

      const laplacian =
        -4 * pixels[idx] +
        pixels[idx - 1] +
        pixels[idx + 1] +
        pixels[idx - width] +
        pixels[idx + width];

      sum += laplacian;
      sumSq += laplacian * laplacian;
      count++;
    }
  }

  if (count === 0) {
    return 0;
  }

  const mean = sum / count;
  return Number((sumSq / count - mean * mean).toFixed(4));
}

function calculateNoiseScore(
  pixels: Uint8Array,
  width: number,
  height: number,
): number {
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;

      const localMean =
        (pixels[idx - width - 1] +
          pixels[idx - width] +
          pixels[idx - width + 1] +
          pixels[idx - 1] +
          pixels[idx] +
          pixels[idx + 1] +
          pixels[idx + width - 1] +
          pixels[idx + width] +
          pixels[idx + width + 1]) /
        9;

      const residual = pixels[idx] - localMean;

      sum += residual;
      sumSq += residual * residual;
      count++;
    }
  }

  if (count === 0) {
    return 0;
  }

  const mean = sum / count;
  return Number(Math.sqrt(sumSq / count - mean * mean).toFixed(4));
}

export async function createEmptyMask(
  value = 0,
  size = TARGET_SIZE,
): Promise<Buffer> {
  const empty = Buffer.alloc(size * size, value);

  return sharp(empty, {
    raw: {
      width: size,
      height: size,
      channels: 1,
    },
  })
    .png()
    .toBuffer();
}
