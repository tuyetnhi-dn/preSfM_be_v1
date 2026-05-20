import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../common/database/database.service';

type CompareBody = {
  pipelineRunId?: string;
  rawOpenSfmRunId?: string;
  processedOpenSfmRunId?: string;
};

type PlyMetrics = {
  pointCount: number;
  format: string | null;
  bbox: null | {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  density: number | null;
};

@Injectable()
export class EvaluationService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  async compare(body: CompareBody) {
    if (
      !body.pipelineRunId ||
      !body.rawOpenSfmRunId ||
      !body.processedOpenSfmRunId
    ) {
      throw new BadRequestException(
        'pipelineRunId, rawOpenSfmRunId and processedOpenSfmRunId are required',
      );
    }
    const rawRun = await this.getOpenSfmRun(body.rawOpenSfmRunId, 'raw');
    const processedRun = await this.getOpenSfmRun(
      body.processedOpenSfmRunId,
      'processed',
    );
    if (
      rawRun.pipeline_run_id !== body.pipelineRunId ||
      processedRun.pipeline_run_id !== body.pipelineRunId
    ) {
      throw new BadRequestException(
        'OpenSfM runs must belong to the same pipelineRunId',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rawFileId = rawRun.dense_ply_file_id || rawRun.sparse_ply_file_id;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const processedFileId =
      processedRun.dense_ply_file_id || processedRun.sparse_ply_file_id;
    if (!rawFileId || !processedFileId) {
      throw new BadRequestException('Both OpenSfM runs must have a PLY output');
    }
    const rawBuffer = await this.downloadStorageFile(rawFileId);
    const processedBuffer = await this.downloadStorageFile(processedFileId);
    const rawPly = this.parsePly(rawBuffer);
    const processedPly = this.parsePly(processedBuffer);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rawMetrics = rawRun.metrics || {};
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const processedMetrics = processedRun.metrics || {};
    const rawReprojectionError = this.pickNumber(rawMetrics, [
      'reprojectionError',
      'average_reprojection_error',
      'reprojection_error',
    ]);
    const processedReprojectionError = this.pickNumber(processedMetrics, [
      'reprojectionError',
      'average_reprojection_error',
      'reprojection_error',
    ]);
    const rawImagesRatio = this.pickNumber(rawMetrics, [
      'reconstructedImagesRatio',
      'reconstructed_images_ratio',
    ]);
    const processedImagesRatio = this.pickNumber(processedMetrics, [
      'reconstructedImagesRatio',
      'reconstructed_images_ratio',
    ]);
    const qualityScore = this.calculateQualityScore({
      rawPointCount: rawPly.pointCount,
      processedPointCount: processedPly.pointCount,
      rawReprojectionError,
      processedReprojectionError,
      rawImagesRatio,
      processedImagesRatio,
    });
    const conclusion = this.buildConclusion(
      qualityScore,
      rawPly.pointCount,
      processedPly.pointCount,
      rawReprojectionError,
      processedReprojectionError,
    );
    const metrics = {
      raw: {
        ply: rawPly,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        opensfm: rawMetrics,
      },
      processed: {
        ply: processedPly,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        opensfm: processedMetrics,
      },
      comparison: {
        pointCountDelta: processedPly.pointCount - rawPly.pointCount,
        pointCountRatio:
          rawPly.pointCount > 0
            ? processedPly.pointCount / rawPly.pointCount
            : null,
        qualityScore,
      },
    };
    const result = await this.databaseService.query(
      `INSERT INTO evaluation_results(
          pipeline_run_id,
          raw_opensfm_run_id,
          processed_opensfm_run_id,
          raw_point_count,
          processed_point_count,
          raw_reprojection_error,
          processed_reprojection_error,
          raw_reconstructed_images_ratio,
          processed_reconstructed_images_ratio,
          raw_processing_time_ms,
          processed_processing_time_ms,
          quality_score,
          conclusion,
          metrics
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       ON CONFLICT(pipeline_run_id)
       DO UPDATE SET raw_opensfm_run_id = EXCLUDED.raw_opensfm_run_id,
                     processed_opensfm_run_id = EXCLUDED.processed_opensfm_run_id,
                     raw_point_count = EXCLUDED.raw_point_count,
                     processed_point_count = EXCLUDED.processed_point_count,
                     raw_reprojection_error = EXCLUDED.raw_reprojection_error,
                     processed_reprojection_error = EXCLUDED.processed_reprojection_error,
                     raw_reconstructed_images_ratio = EXCLUDED.raw_reconstructed_images_ratio,
                     processed_reconstructed_images_ratio = EXCLUDED.processed_reconstructed_images_ratio,
                     raw_processing_time_ms = EXCLUDED.raw_processing_time_ms,
                     processed_processing_time_ms = EXCLUDED.processed_processing_time_ms,
                     quality_score = EXCLUDED.quality_score,
                     conclusion = EXCLUDED.conclusion,
                     metrics = EXCLUDED.metrics
       RETURNING *`,
      [
        body.pipelineRunId,
        body.rawOpenSfmRunId,
        body.processedOpenSfmRunId,
        rawPly.pointCount,
        processedPly.pointCount,
        rawReprojectionError,
        processedReprojectionError,
        rawImagesRatio,
        processedImagesRatio,
        rawRun.processing_time_ms,
        processedRun.processing_time_ms,
        qualityScore,
        conclusion,
        JSON.stringify(metrics),
      ],
    );
    await this.databaseService.query(
      `UPDATE pipeline_steps SET status = 'completed', progress = 100, completed_at = NOW() WHERE pipeline_run_id = $1 AND step_key = 'evaluation'`,
      [body.pipelineRunId],
    );
    await this.databaseService.query(
      `UPDATE pipeline_runs SET status = 'completed', progress = 100, completed_at = NOW() WHERE id = $1`,
      [body.pipelineRunId],
    );
    return this.mapEvaluation(result.rows[0]);
  }

  async findById(id: string) {
    const result = await this.databaseService.query(
      `SELECT * FROM evaluation_results WHERE id = $1`,
      [id],
    );
    const evaluation = result.rows[0];
    if (!evaluation) {
      throw new NotFoundException('Evaluation result not found');
    }
    return this.mapEvaluation(evaluation);
  }

  async findByPipeline(pipelineRunId: string) {
    const result = await this.databaseService.query(
      `SELECT * FROM evaluation_results WHERE pipeline_run_id = $1`,
      [pipelineRunId],
    );
    const evaluation = result.rows[0];
    if (!evaluation) {
      throw new NotFoundException('Evaluation result not found');
    }
    return this.mapEvaluation(evaluation);
  }

  async metrics(id: string) {
    const evaluation = await this.findById(id);
    return evaluation.metrics;
  }

  private async getOpenSfmRun(id: string, branch: 'raw' | 'processed') {
    const result = await this.databaseService.query(
      `SELECT * FROM opensfm_runs WHERE id = $1 AND branch = $2`,
      [id, branch],
    );
    const run = result.rows[0];
    if (!run) {
      throw new NotFoundException(`${branch} OpenSfM run not found`);
    }
    return run;
  }

  private async downloadStorageFile(fileId: string) {
    const response = await fetch(
      `${this.storageServiceUrl()}/storage/files/${fileId}/download`,
    );
    if (!response.ok) {
      throw new BadRequestException(await response.text());
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private storageServiceUrl() {
    return this.configService.get<string>(
      'STORAGE_SERVICE_URL',
      'http://storage-service:8004',
    );
  }

  private parsePly(buffer: Buffer): PlyMetrics {
    const textStart = buffer
      .subarray(0, Math.min(buffer.length, 1024 * 1024))
      .toString('utf8');
    const headerEndIndex = textStart.indexOf('end_header');
    if (!textStart.startsWith('ply') || headerEndIndex < 0) {
      return { pointCount: 0, format: null, bbox: null, density: null };
    }
    const header = textStart.slice(0, headerEndIndex).split(/\n/);
    const vertexLine = header.find((line) =>
      line.startsWith('element vertex '),
    );
    const formatLine = header.find((line) => line.startsWith('format '));
    const pointCount = vertexLine ? Number(vertexLine.split(/\s+/)[2]) : 0;
    const format = formatLine ? formatLine.split(/\s+/)[1] : null;
    if (format !== 'ascii') {
      return { pointCount, format, bbox: null, density: null };
    }
    const bodyStart = textStart.indexOf('\n', headerEndIndex) + 1;
    const body = textStart.slice(bodyStart).split(/\n/);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let parsed = 0;
    const limit = Math.min(pointCount, body.length, 100000);
    for (let i = 0; i < limit; i += 1) {
      const parts = body[i].trim().split(/\s+/);
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if ([x, y, z].every(Number.isFinite)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
        parsed += 1;
      }
    }
    if (parsed === 0) {
      return { pointCount, format, bbox: null, density: null };
    }
    const volume = Math.max((maxX - minX) * (maxY - minY) * (maxZ - minZ), 0);
    return {
      pointCount,
      format,
      bbox: { minX, minY, minZ, maxX, maxY, maxZ },
      density: volume > 0 ? pointCount / volume : null,
    };
  }

  private pickNumber(metrics: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = metrics[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
    return null;
  }

  private calculateQualityScore(input: {
    rawPointCount: number;
    processedPointCount: number;
    rawReprojectionError: number | null;
    processedReprojectionError: number | null;
    rawImagesRatio: number | null;
    processedImagesRatio: number | null;
  }) {
    const pointScore =
      input.rawPointCount > 0
        ? Math.min((input.processedPointCount / input.rawPointCount) * 40, 40)
        : 0;
    const errorScore =
      input.rawReprojectionError && input.processedReprojectionError
        ? Math.max(
            0,
            Math.min(
              (input.rawReprojectionError / input.processedReprojectionError) *
                30,
              30,
            ),
          )
        : 15;
    const imageScore =
      input.rawImagesRatio && input.processedImagesRatio
        ? Math.max(
            0,
            Math.min(
              (input.processedImagesRatio / input.rawImagesRatio) * 20,
              20,
            ),
          )
        : 10;
    const stabilityScore = input.processedPointCount > 0 ? 10 : 0;
    return Number(
      Math.max(
        0,
        Math.min(pointScore + errorScore + imageScore + stabilityScore, 100),
      ).toFixed(3),
    );
  }

  private buildConclusion(
    score: number,
    rawPointCount: number,
    processedPointCount: number,
    rawError: number | null,
    processedError: number | null,
  ) {
    const pointDelta = processedPointCount - rawPointCount;
    const errorImproved =
      rawError !== null && processedError !== null && processedError < rawError;
    if (score >= 70 && (pointDelta >= 0 || errorImproved)) {
      return 'Nhánh tiền xử lý cho kết quả tốt hơn hoặc ổn định hơn nhánh gốc.';
    }
    if (score >= 50) {
      return 'Nhánh tiền xử lý có cải thiện một phần nhưng cần kiểm tra trực quan point cloud và report OpenSfM.';
    }
    return 'Chưa đủ bằng chứng cho thấy tiền xử lý cải thiện chất lượng đầu ra OpenSfM.';
  }

  private mapEvaluation(row: Record<string, unknown>) {
    return {
      id: row.id,
      pipelineRunId: row.pipeline_run_id,
      rawOpenSfmRunId: row.raw_opensfm_run_id,
      processedOpenSfmRunId: row.processed_opensfm_run_id,
      rawPointCount: row.raw_point_count,
      processedPointCount: row.processed_point_count,
      rawReprojectionError: row.raw_reprojection_error,
      processedReprojectionError: row.processed_reprojection_error,
      rawReconstructedImagesRatio: row.raw_reconstructed_images_ratio,
      processedReconstructedImagesRatio:
        row.processed_reconstructed_images_ratio,
      rawProcessingTimeMs: row.raw_processing_time_ms,
      processedProcessingTimeMs: row.processed_processing_time_ms,
      qualityScore: row.quality_score,
      conclusion: row.conclusion,
      metrics: row.metrics,
      reportFileId: row.report_file_id,
      createdAt: row.created_at,
    };
  }
}
