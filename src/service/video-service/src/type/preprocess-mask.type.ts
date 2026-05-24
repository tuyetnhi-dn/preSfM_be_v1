export type PreprocessAndMaskBody = {
  pipelineRunId?: string;
  config?: {
    blurThreshold?: number;
    noiseThreshold?: number;
    outputProcessedFolder?: string;
    outputMaskFolder?: string;
  };
};

export type MaskGenerationFrameInput = {
  frameId: string;
  frameIndex: number;
  rawStorageFileId: string;
};

export type MaskGenerationResponse = {
  images: Array<{
    frameId: string;
    frameIndex: number;
    blurScore: number | null;
    noiseScore: number | null;
    isSelected: boolean;
    rejectedReason: string | null;
    processedStorageFileId: string | null;
    maskStorageFileId: string | null;
  }>;
  total: number;
  selectedCount: number;
  rejectedCount: number;
};
