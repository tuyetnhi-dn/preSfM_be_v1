/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { VideoPipelineRunnerService } from './video-pipeline-runner.service';
import {
  FULL_PIPELINE_QUEUE,
  RUN_FULL_PIPELINE_JOB,
} from '../pipeline/pipeline-queue.constants';
import { FullPipelineJobData } from '../type/full-pipeline-job.type';

const concurrency = Number(process.env.FULL_PIPELINE_CONCURRENCY ?? 1);

@Processor(FULL_PIPELINE_QUEUE, {
  concurrency,
})
export class FullPipelineProcessor extends WorkerHost {
  constructor(
    private readonly videoPipelineRunnerService: VideoPipelineRunnerService,
  ) {
    super();
  }

  async process(job: Job<FullPipelineJobData>) {
    if (job.name !== RUN_FULL_PIPELINE_JOB) {
      return null;
    }

    return this.videoPipelineRunnerService.run(job.data, job);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<FullPipelineJobData>) {
    console.log(
      `[FullPipelineProcessor] completed job=${job.id} pipelineRunId=${job.data.pipelineRunId}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<FullPipelineJobData> | undefined, error: Error) {
    console.error(
      `[FullPipelineProcessor] failed job=${job?.id} error=${error.message}`,
    );
  }
}
