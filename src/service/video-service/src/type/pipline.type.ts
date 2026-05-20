export type PipelineType = 'raw' | 'processed';

export type CreatePipelineBody = {
  sampleFps?: number;
  pipelineType: PipelineType;
  config?: Record<string, unknown>;
};
