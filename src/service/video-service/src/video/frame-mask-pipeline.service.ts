import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import {
  MaskGenerationFrameInput,
  MaskGenerationResponse,
  PreprocessAndMaskBody,
} from '../type/preprocess-mask.type';

@Injectable()
export class FrameMaskPipelineService {
  preprocessAndGenerateMasks(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    videoId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    arg1: {
      pipelineRunId: string;
      config: {
        blurThreshold: number;
        noiseThreshold: number;
        outputProcessedFolder: string;
        outputMaskFolder: string;
      };
    },
  ) {
    throw new Error('Method not implemented.');
  }
  constructor(private readonly databaseService: DatabaseService) {}

  async run(
    videoId: string,
    input: {
      datasetId: string;
      videoId: string;
      pipelineRunId?: string;
      body: PreprocessAndMaskBody;
    },
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const pipelineRunId =
      input.pipelineRunId ??
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      input.body.pipelineRunId ??
      (await this.findLatestPipelineRun(input.videoId)) ??
      (await this.createPipelineRun(
        input.datasetId,
        input.videoId,
        input.body,
      ));

    await this.ensurePipelineStep(
      pipelineRunId,
      'preprocessing',
      'Filter noisy and blurry frames',
    );

    await this.ensurePipelineStep(
      pipelineRunId,
      'mask_generation',
      'Generate masks from processed images',
    );

    await this.updatePipelineRun(pipelineRunId, {
      status: 'running',
      progress: 35,
    });

    await this.updatePipelineStep(pipelineRunId, 'preprocessing', {
      status: 'running',
      progress: 10,
      started_at: new Date().toISOString(),
    });

    // const frames = await this.getRawFrames(input.videoId);

    // if (frames.length === 0) {
    //   throw new BadRequestException('No raw frames found for this video');
    // }
    const rawFrames = await this.getRawFramesByDatasetId(input.datasetId);

    if (!rawFrames.length) {
      throw new Error(
        'No raw frames found for this dataset after frame extraction',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.callMaskGenerationService({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      pipelineRunId,
      datasetId: input.datasetId,
      videoId: input.videoId,
      frames: rawFrames.map((row) => ({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        frameId: row.id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        frameIndex: Number(row.frameIndex),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        rawStorageFileId: row.storageFileId,
      })),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      body: input.body,
    });

    await this.updateFrames(result);

    await this.updateDatasetCounts({
      datasetId: input.datasetId,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      selectedCount: result.selectedCount,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      rejectedCount: result.rejectedCount,
    });

    await this.updatePipelineStep(pipelineRunId, 'preprocessing', {
      status: 'completed',
      progress: 100,
      completed_at: new Date().toISOString(),
    });

    await this.updatePipelineStep(pipelineRunId, 'mask_generation', {
      status: 'completed',
      progress: 100,
      completed_at: new Date().toISOString(),
    });

    const updatedPipelineRun = await this.updatePipelineRun(pipelineRunId, {
      status: 'running',
      progress: 60,
    });

    return {
      pipelineRun: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        id: updatedPipelineRun.id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        datasetId: updatedPipelineRun.dataset_id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        videoId: updatedPipelineRun.video_id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        status: updatedPipelineRun.status,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        progress: updatedPipelineRun.progress,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        pipelineType: updatedPipelineRun.pipeline_type,
        stage: 'masks_completed',
      },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      total: result.total,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      selectedCount: result.selectedCount,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      rejectedCount: result.rejectedCount,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      images: result.images,
    };
  }

  private async getRawFrames(
    videoId: string,
  ): Promise<MaskGenerationFrameInput[]> {
    const result = await this.databaseService.query(
      `SELECT id, frame_index, raw_storage_file_id
       FROM frames
       WHERE video_id = $1
         AND raw_storage_file_id IS NOT NULL
       ORDER BY frame_index ASC`,
      [videoId],
    );

    return result.rows.map((row) => ({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      frameId: row.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      frameIndex: Number(row.frame_index),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      rawStorageFileId: row.raw_storage_file_id,
    }));
  }
  private async getRawFramesByDatasetId(datasetId: string) {
    const result = await this.databaseService.query(
      `
    SELECT
      f.id,
      f.dataset_id AS "datasetId",
      f.frame_index AS "frameIndex",
      f.timestamp_ms AS "timestampMs",
      f.width,
      f.height,
      sf.id AS "storageFileId",
      sf.object_path AS "objectPath",
      sf.original_name AS "originalName",
      sf.mime_type AS "mimeType"
    FROM frames f
    JOIN storage_files sf ON sf.id = f.raw_storage_file_id
    WHERE f.dataset_id = $1
      AND f.raw_storage_file_id IS NOT NULL
    ORDER BY f.frame_index ASC
    `,
      [datasetId],
    );

    return result.rows;
  }

  private async callMaskGenerationService(input: {
    pipelineRunId: string;
    datasetId: string;
    videoId: string;
    frames: MaskGenerationFrameInput[];
    body: PreprocessAndMaskBody;
  }): Promise<MaskGenerationResponse> {
    const serviceUrl =
      process.env.MASK_GENERATION_SERVICE_URL ??
      'http://mask-generation-service:8002';

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const config = input.body.config ?? {};

    const response = await fetch(
      `${serviceUrl}/mask-generation/process-raw-frames`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pipelineRunId: input.pipelineRunId,
          datasetId: input.datasetId,
          videoId: input.videoId,
          frames: input.frames,
          config: {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            blurThreshold: Number(config.blurThreshold ?? 250),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            noiseThreshold: Number(config.noiseThreshold ?? 25),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            outputProcessedFolder:
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              config.outputProcessedFolder ?? 'processed_images',
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            outputMaskFolder: config.outputMaskFolder ?? 'masks',
          },
        }),
      },
    );

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Mask generation service error: ${await response.text()}`,
      );
    }

    return (await response.json()) as MaskGenerationResponse;
  }

  private async updateFrames(data: MaskGenerationResponse) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    for (const item of data.images) {
      await this.databaseService.query(
        `UPDATE frames
         SET
           blur_score = $2,
           noise_score = $3,
           is_selected = $4,
           rejected_reason = $5,
           processed_storage_file_id = $6,
           mask_storage_file_id = $7,
           updated_at = NOW()
         WHERE id = $1`,
        [
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          item.frameId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          item.blurScore,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          item.noiseScore,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          item.isSelected,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          item.rejectedReason,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          item.processedStorageFileId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          item.maskStorageFileId,
        ],
      );
    }
  }

  private async updateDatasetCounts(input: {
    datasetId: string;
    selectedCount: number;
    rejectedCount: number;
  }) {
    await this.databaseService.query(
      `UPDATE datasets
       SET
         selected_frame_count = $2,
         rejected_frame_count = $3,
         mask_count = $2,
         updated_at = NOW()
       WHERE id = $1`,
      [input.datasetId, input.selectedCount, input.rejectedCount],
    );
  }

  private async findLatestPipelineRun(videoId: string): Promise<string | null> {
    const result = await this.databaseService.query(
      `SELECT id
       FROM pipeline_runs
       WHERE video_id = $1
         AND pipeline_type = 'processed'
         AND status IN ('pending', 'running')
       ORDER BY created_at DESC
       LIMIT 1`,
      [videoId],
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return result.rows[0]?.id ?? null;
  }

  private async createPipelineRun(
    datasetId: string,
    videoId: string,
    body: PreprocessAndMaskBody,
  ): Promise<string> {
    const result = await this.databaseService.query(
      `INSERT INTO pipeline_runs(dataset_id, video_id, status, progress, config, pipeline_type)
       VALUES ($1, $2, 'running', 30, $3::jsonb, 'processed')
       RETURNING id`,
      [
        datasetId,
        videoId,
        JSON.stringify({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          ...(body.config ?? {}),
          stage: 'preprocessing',
        }),
      ],
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return result.rows[0].id;
  }

  private async ensurePipelineStep(
    pipelineRunId: string,
    stepKey: string,
    stepName: string,
  ) {
    await this.databaseService.query(
      `INSERT INTO pipeline_steps(pipeline_run_id, step_key, step_name, status, progress)
       VALUES ($1, $2, $3, 'pending', 0)
       ON CONFLICT(pipeline_run_id, step_key) DO NOTHING`,
      [pipelineRunId, stepKey, stepName],
    );
  }

  private async updatePipelineRun(
    pipelineRunId: string,
    fields: Record<string, unknown>,
  ) {
    const entries = Object.entries(fields).filter(
      ([, value]) => value !== undefined,
    );

    const values = entries.map(([, value]) => value);

    const setClause = entries
      .map(([key], index) => `${key} = $${index + 2}`)
      .join(', ');

    const result = await this.databaseService.query(
      `UPDATE pipeline_runs
       SET ${setClause}, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [pipelineRunId, ...values],
    );

    if (!result.rows[0]) {
      throw new InternalServerErrorException('Cannot update pipeline run');
    }

    return result.rows[0];
  }

  private async updatePipelineStep(
    pipelineRunId: string,
    stepKey: string,
    fields: Record<string, unknown>,
  ) {
    const entries = Object.entries(fields).filter(
      ([, value]) => value !== undefined,
    );

    if (entries.length === 0) {
      return;
    }

    const values = entries.map(([, value]) => value);

    const setClause = entries
      .map(([key], index) => `${key} = $${index + 3}`)
      .join(', ');

    await this.databaseService.query(
      `UPDATE pipeline_steps
       SET ${setClause}
       WHERE pipeline_run_id = $1
         AND step_key = $2`,
      [pipelineRunId, stepKey, ...values],
    );
  }
}
