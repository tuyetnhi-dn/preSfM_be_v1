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

export async function resizeWithPadding(
  inputBuffer: Buffer,
): Promise<ResizeResult> {
  const meta = await sharp(inputBuffer).metadata();
  if (meta.width == null || meta.height == null) {
    throw new Error('Image metadata missing width or height');
  }

  const originalWidth = meta.width;
  const originalHeight = meta.height;

  const isLandscape = originalWidth >= originalHeight;

  // Scale sao cho cạnh dài nhất = TARGET_SIZE
  const scale = TARGET_SIZE / Math.max(originalWidth, originalHeight);
  const scaledWidth = Math.round(originalWidth * scale);
  const scaledHeight = Math.round(originalHeight * scale);

  // Padding để đạt 768×768
  const padTop = isLandscape ? Math.floor((TARGET_SIZE - scaledHeight) / 2) : 0;
  const padLeft = isLandscape ? 0 : Math.floor((TARGET_SIZE - scaledWidth) / 2);

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
