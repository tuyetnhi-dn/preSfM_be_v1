import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  FULL_PIPELINE_QUEUE,
  RUN_FULL_PIPELINE_JOB,
} from '../pipeline/pipeline-queue.constants';
import { FullPipelineJobData } from '../type/full-pipeline-job.type';

@Injectable()
export class FullPipelineQueueService {
  constructor(
    @InjectQueue(FULL_PIPELINE_QUEUE)
    private readonly queue: Queue<FullPipelineJobData>,
  ) {}

  async addRunFullPipelineJob(data: FullPipelineJobData) {
    return this.queue.add(RUN_FULL_PIPELINE_JOB, data, {
      jobId: data.pipelineRunId,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
  }
}
