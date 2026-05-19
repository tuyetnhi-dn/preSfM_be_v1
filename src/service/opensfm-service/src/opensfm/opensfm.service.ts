import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../common/database/database.service';

type CreateOpenSfmRunBody = {
  pipelineRunId?: string;
  datasetId?: string;
  branch?: 'raw' | 'processed';
  workspacePath?: string;
  config?: Record<string, unknown>;
};

type CompleteRunBody = {
  status?: 'completed' | 'failed';
  reconstructionFileId?: string;
  sparsePlyFileId?: string;
  densePlyFileId?: string;
  statsFileId?: string;
  reportFileId?: string;
  commandLog?: string;
  metrics?: Record<string, unknown>;
  processingTimeMs?: number;
  errorMessage?: string;
};

@Injectable()
export class OpenSfmService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  async createRun(body: CreateOpenSfmRunBody) {
    if (!body.pipelineRunId || !body.datasetId || !body.branch) {
      throw new BadRequestException('pipelineRunId, datasetId and branch are required');
    }
    if (!['raw', 'processed'].includes(body.branch)) {
      throw new BadRequestException('branch must be raw or processed');
    }
    await this.ensurePipelineAndDataset(body.pipelineRunId, body.datasetId);
    const result = await this.databaseService.query(
      `INSERT INTO opensfm_runs(pipeline_run_id, dataset_id, branch, status, workspace_path, metrics)
       VALUES ($1, $2, $3, 'pending', $4, $5::jsonb)
       ON CONFLICT(pipeline_run_id, branch)
       DO UPDATE SET workspace_path = EXCLUDED.workspace_path, metrics = opensfm_runs.metrics || EXCLUDED.metrics
       RETURNING *`,
      [body.pipelineRunId, body.datasetId, body.branch, body.workspacePath || null, JSON.stringify(body.config || {})],
    );
    return this.mapRun(result.rows[0]);
  }

  async list(pipelineRunId?: string) {
    const result = pipelineRunId
      ? await this.databaseService.query(`SELECT * FROM opensfm_runs WHERE pipeline_run_id = $1 ORDER BY created_at DESC`, [pipelineRunId])
      : await this.databaseService.query(`SELECT * FROM opensfm_runs ORDER BY created_at DESC LIMIT 100`);
    return result.rows.map((row) => this.mapRun(row));
  }

  async findById(id: string) {
    const result = await this.databaseService.query(`SELECT * FROM opensfm_runs WHERE id = $1`, [id]);
    const run = result.rows[0];
    if (!run) {
      throw new NotFoundException('OpenSfM run not found');
    }
    return this.mapRun(run);
  }

  async start(id: string) {
    const run = await this.findById(id);
    const result = await this.databaseService.query(
      `UPDATE opensfm_runs
       SET status = 'running', started_at = COALESCE(started_at, NOW()), error_message = NULL
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    await this.databaseService.query(
      `UPDATE pipeline_steps
       SET status = 'running', started_at = COALESCE(started_at, NOW()), progress = 10
       WHERE pipeline_run_id = $1 AND step_key = $2`,
      [run.pipelineRunId, run.branch === 'raw' ? 'opensfm_raw' : 'opensfm_processed'],
    );
    await this.callWorkerIfConfigured(result.rows[0]);
    return this.mapRun(result.rows[0]);
  }

  async complete(id: string, body: CompleteRunBody) {
    const status = body.status || 'completed';
    if (!['completed', 'failed'].includes(status)) {
      throw new BadRequestException('status must be completed or failed');
    }
    const result = await this.databaseService.query(
      `UPDATE opensfm_runs
       SET status = $2,
           reconstruction_file_id = COALESCE($3, reconstruction_file_id),
           sparse_ply_file_id = COALESCE($4, sparse_ply_file_id),
           dense_ply_file_id = COALESCE($5, dense_ply_file_id),
           stats_file_id = COALESCE($6, stats_file_id),
           report_file_id = COALESCE($7, report_file_id),
           command_log = COALESCE($8, command_log),
           metrics = metrics || $9::jsonb,
           processing_time_ms = COALESCE($10, processing_time_ms),
           error_message = $11,
           completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, status, body.reconstructionFileId || null, body.sparsePlyFileId || null, body.densePlyFileId || null, body.statsFileId || null, body.reportFileId || null, body.commandLog || null, JSON.stringify(body.metrics || {}), body.processingTimeMs || null, body.errorMessage || null],
    );
    const run = result.rows[0];
    if (!run) {
      throw new NotFoundException('OpenSfM run not found');
    }
    await this.insertOutputs(run);
    await this.databaseService.query(
      `UPDATE pipeline_steps
       SET status = $3, progress = CASE WHEN $3 = 'completed' THEN 100 ELSE progress END, completed_at = NOW(), error_message = $4
       WHERE pipeline_run_id = $1 AND step_key = $2`,
      [run.pipeline_run_id, run.branch === 'raw' ? 'opensfm_raw' : 'opensfm_processed', status, body.errorMessage || null],
    );
    return this.mapRun(run);
  }

  async outputs(id: string) {
    await this.findById(id);
    const result = await this.databaseService.query(
      `SELECT oo.id, oo.kind, oo.metadata, sf.id AS storage_file_id, sf.provider, sf.bucket, sf.object_path, sf.mime_type, sf.size_bytes
       FROM opensfm_outputs oo
       JOIN storage_files sf ON sf.id = oo.storage_file_id
       WHERE oo.opensfm_run_id = $1
       ORDER BY oo.created_at ASC`,
      [id],
    );
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      metadata: row.metadata,
      storageFile: {
        id: row.storage_file_id,
        provider: row.provider,
        bucket: row.bucket,
        objectPath: row.object_path,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
      },
    }));
  }

  async logs(id: string) {
    const run = await this.findById(id);
    return { id: run.id, commandLog: run.commandLog || '' };
  }

  private async ensurePipelineAndDataset(pipelineRunId: string, datasetId: string) {
    const result = await this.databaseService.query(
      `SELECT pr.id
       FROM pipeline_runs pr
       JOIN datasets d ON d.id = pr.dataset_id
       WHERE pr.id = $1 AND d.id = $2`,
      [pipelineRunId, datasetId],
    );
    if (!result.rows[0]) {
      throw new BadRequestException('Pipeline run and dataset do not match');
    }
  }

  private async insertOutputs(run: Record<string, unknown>) {
    const mappings: Array<[string, unknown]> = [
      ['reconstruction', run.reconstruction_file_id],
      ['sparse_ply', run.sparse_ply_file_id],
      ['dense_ply', run.dense_ply_file_id],
      ['stats', run.stats_file_id],
      ['report', run.report_file_id],
    ];
    for (const [kind, fileId] of mappings) {
      if (fileId) {
        await this.databaseService.query(
          `INSERT INTO opensfm_outputs(opensfm_run_id, kind, storage_file_id)
           VALUES ($1, $2, $3)
           ON CONFLICT(opensfm_run_id, kind, storage_file_id) DO NOTHING`,
          [run.id, kind, fileId],
        );
      }
    }
  }

  private async callWorkerIfConfigured(run: Record<string, unknown>) {
    const workerUrl = this.configService.get<string>('OPENSFM_WORKER_URL');
    if (!workerUrl) {
      return;
    }
    await fetch(`${workerUrl.replace(/\/$/, '')}/jobs/opensfm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ opensfmRunId: run.id }),
    }).catch(() => undefined);
  }

  private mapRun(row: Record<string, unknown>) {
    return {
      id: row.id,
      pipelineRunId: row.pipeline_run_id,
      datasetId: row.dataset_id,
      branch: row.branch,
      status: row.status,
      workspacePath: row.workspace_path,
      reconstructionFileId: row.reconstruction_file_id,
      sparsePlyFileId: row.sparse_ply_file_id,
      densePlyFileId: row.dense_ply_file_id,
      statsFileId: row.stats_file_id,
      reportFileId: row.report_file_id,
      commandLog: row.command_log,
      metrics: row.metrics,
      processingTimeMs: row.processing_time_ms,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    };
  }
}
