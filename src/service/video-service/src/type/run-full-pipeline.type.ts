export type RunFullPipelineDto = {
  sampleFps?: number;
  blurThreshold?: number;
  noiseThreshold?: number;
  runDense?: boolean;
  mode?: 'quick' | 'balanced' | 'quality';
};

export type RunFullPipelineResponse = {
  message: string;
  videoId: string;
  pipelineRunId: string;
  jobId: string;
};

export type PipelineRunStatusResponse = {
  id: string;
  videoId: string | null;
  datasetId: string | null;
  status: string;
  progress: number | null;
  currentStage?: string | null;
  config: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
};
