import type { RunFullPipelineDto } from '../type/run-full-pipeline.type';

export type FullPipelineJobData = {
  videoId: string;
  pipelineRunId: string;
  dto: RunFullPipelineDto;
};
