/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import type {
  PaginatedResponse,
  ProjectListItemDto,
  ProjectListQuery,
} from './project-list.type';
import {
  buildShotViewpointMap,
  normalizeFrameName,
} from './helpers/opensfm-viewpoint.helper';

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 12;

function parsePage(value?: string) {
  const page = Number(value ?? 1);

  if (!Number.isFinite(page) || page < 1) return 1;

  return Math.floor(page);
}

function parseLimit(value?: string) {
  const limit = Number(value ?? DEFAULT_LIMIT);

  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;

  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function buildSupabasePublicUrl(input: {
  bucket?: string | null;
  objectPath?: string | null;
}) {
  if (!input.bucket || !input.objectPath) return null;

  const supabaseUrl = process.env.SUPABASE_URL;

  if (!supabaseUrl) return null;

  const baseUrl = supabaseUrl.replace(/\/$/, '');

  const encodedObjectPath = input.objectPath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  return `${baseUrl}/storage/v1/object/public/${input.bucket}/${encodedObjectPath}`;
}

function publicApiBaseUrl() {
  return (
    process.env.PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:8000/api'
  ).replace(/\/$/, '');
}

function internalApiBaseUrl() {
  return (
    process.env.INTERNAL_API_URL ??
    process.env.PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:8000/api'
  ).replace(/\/$/, '');
}

function storageDownloadUrl(fileId?: string | null) {
  if (!fileId) return null;

  return `${publicApiBaseUrl()}/storage/files/${fileId}/download`;
}

function internalStorageDownloadUrl(fileId?: string | null) {
  if (!fileId) return null;

  return `${internalApiBaseUrl()}/storage/files/${fileId}/download`;
}

async function fetchJsonFromDownloadUrl(fileId?: string | null) {
  if (!fileId) return null;

  const url = internalStorageDownloadUrl(fileId);

  if (!url) return null;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.warn(
        `[ProjectService] Failed to fetch JSON file ${fileId}: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    return response.json();
  } catch (error) {
    console.warn(`[ProjectService] Failed to fetch JSON file ${fileId}`, error);
    return null;
  }
}
function basename(value?: string | null) {
  if (!value) return null;

  return value.replace(/\\/g, '/').split('/').pop() ?? null;
}

function pickFrameName(row: any, prefix: 'raw' | 'processed' | 'mask') {
  return (
    row?.[`${prefix}OriginalName`] ??
    basename(row?.[`${prefix}ObjectPath`]) ??
    basename(row?.[`${prefix}Path`]) ??
    null
  );
}
function findViewpoint(
  viewpointMap: Map<string, any>,
  names: Array<string | null | undefined>,
) {
  for (const name of names) {
    const normalizedName = normalizeFrameName(name);

    if (!normalizedName) continue;

    const direct = viewpointMap.get(normalizedName);

    if (direct) {
      return direct;
    }

    const nameWithoutExt = normalizedName.replace(/\.[^.]+$/, '');

    const candidates = [
      `${nameWithoutExt}.jpg`,
      `${nameWithoutExt}.jpeg`,
      `${nameWithoutExt}.png`,
    ];

    for (const candidate of candidates) {
      const viewpoint = viewpointMap.get(candidate);

      if (viewpoint) {
        return viewpoint;
      }
    }
  }

  return null;
}

@Injectable()
export class ProjectService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listProjects(
    query: ProjectListQuery,
  ): Promise<PaginatedResponse<ProjectListItemDto>> {
    const scope = query.scope ?? 'public';
    const page = parsePage(query.page);
    const limit = parseLimit(query.limit);
    const offset = (page - 1) * limit;

    const values: unknown[] = [];
    let whereClause = '';

    if (scope === 'mine') {
      if (!query.userId) {
        throw new BadRequestException('Missing userId for mine projects');
      }

      values.push(query.userId);
      whereClause = `WHERE p.user_id = $1`;
    } else {
      whereClause = `WHERE p.visibility = 'public'`;
    }

    const countResult = await this.databaseService.query(
      `
      SELECT COUNT(*)::int AS total
      FROM projects p
      ${whereClause}
      `,
      values,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);

    values.push(limit);
    values.push(offset);

    const limitIndex = values.length - 1;
    const offsetIndex = values.length;

    const result = await this.databaseService.query(
      `
      SELECT
        p.id,
        p.name,
        p.description,
        p.visibility,
        p.status,
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt",

        cover_file.bucket AS "coverImageBucket",
        cover_file.object_path AS "coverImageObjectPath",

        latest.id AS "latestPipelineId",
        latest.status AS "latestPipelineStatus",
        latest.progress AS "latestPipelineProgress",
        latest.current_stage AS "latestPipelineCurrentStage",
        latest.created_at AS "latestPipelineCreatedAt",
        latest.updated_at AS "latestPipelineUpdatedAt"
      FROM projects p

LEFT JOIN LATERAL (
  SELECT
    COALESCE(processed_file.bucket, raw_file.bucket) AS bucket,
    COALESCE(processed_file.object_path, raw_file.object_path) AS object_path
  FROM datasets d
  JOIN frames f
    ON f.dataset_id = d.id

  LEFT JOIN storage_files processed_file
    ON processed_file.id = f.processed_storage_file_id

  LEFT JOIN storage_files raw_file
    ON raw_file.id = f.raw_storage_file_id

  WHERE d.project_id = p.id
    AND (
      processed_file.object_path IS NOT NULL
      OR raw_file.object_path IS NOT NULL
    )

  ORDER BY f.frame_index ASC
  LIMIT 1
) cover_file ON true

      LEFT JOIN LATERAL (
        SELECT
          pr.id,
          pr.status,
          pr.progress,
          pr.current_stage,
          pr.created_at,
          pr.updated_at
        FROM datasets d
        JOIN pipeline_runs pr ON pr.dataset_id = d.id
        WHERE d.project_id = p.id
        ORDER BY pr.created_at DESC
        LIMIT 1
      ) latest ON true

      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
      `,
      values,
    );

    const items: ProjectListItemDto[] = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      visibility: row.visibility,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,

      coverImageUrl: buildSupabasePublicUrl({
        bucket: row.coverImageBucket,
        objectPath: row.coverImageObjectPath,
      }),

      latestPipeline: row.latestPipelineId
        ? {
            id: row.latestPipelineId,
            status: row.latestPipelineStatus,
            progress: row.latestPipelineProgress ?? null,
            currentStage: row.latestPipelineCurrentStage ?? null,
            createdAt: row.latestPipelineCreatedAt,
            updatedAt: row.latestPipelineUpdatedAt,
          }
        : null,
    }));

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }

  async getProjectofUserById(input: { projectId: string; userId?: string }) {
    const result = await this.databaseService.query(
      `
    SELECT
      p.id,
      p.user_id AS "userId",
      p.name,
      p.description,
      p.visibility,
      p.status,

      d.id AS "datasetId",
      v.id AS "videoId",

      video_file.bucket AS "videoBucket",
      video_file.object_path AS "videoObjectPath",
      video_file.original_name AS "videoOriginalName",
      video_file.mime_type AS "videoMimeType",
      video_file.size_bytes AS "videoSizeBytes",

      p.created_at AS "createdAt",
      p.updated_at AS "updatedAt",

      cover_file.bucket AS "coverImageBucket",
      cover_file.object_path AS "coverImageObjectPath",

      latest.id AS "latestPipelineId",
      latest.status AS "latestPipelineStatus",
      latest.progress AS "latestPipelineProgress",
      latest.current_stage AS "latestPipelineCurrentStage",
      latest.created_at AS "latestPipelineCreatedAt",
      latest.updated_at AS "latestPipelineUpdatedAt"
    FROM projects p

    LEFT JOIN datasets d
      ON d.project_id = p.id

    LEFT JOIN videos v
      ON v.dataset_id = d.id

    LEFT JOIN storage_files video_file
      ON video_file.id = v.storage_file_id

    LEFT JOIN LATERAL (
      SELECT
        COALESCE(processed_file.bucket, raw_file.bucket) AS bucket,
        COALESCE(processed_file.object_path, raw_file.object_path) AS object_path
      FROM datasets d3
      JOIN frames f
        ON f.dataset_id = d3.id

      LEFT JOIN storage_files processed_file
        ON processed_file.id = f.processed_storage_file_id

      LEFT JOIN storage_files raw_file
        ON raw_file.id = f.raw_storage_file_id

      WHERE d3.project_id = p.id
        AND (
          processed_file.object_path IS NOT NULL
          OR raw_file.object_path IS NOT NULL
        )

      ORDER BY f.frame_index ASC
      LIMIT 1
    ) cover_file ON true

    LEFT JOIN LATERAL (
      SELECT
        pr.id,
        pr.status,
        pr.progress,
        pr.current_stage,
        pr.created_at,
        pr.updated_at
      FROM datasets d2
      JOIN pipeline_runs pr
        ON pr.dataset_id = d2.id
      WHERE d2.project_id = p.id
      ORDER BY pr.created_at DESC
      LIMIT 1
    ) latest ON true

    WHERE p.id = $1
    ORDER BY d.created_at DESC NULLS LAST, v.created_at DESC NULLS LAST
    LIMIT 1
    `,
      [input.projectId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException(`Project ${input.projectId} not found`);
    }

    const isOwner = input.userId && row.userId === input.userId;
    const isPublic = row.visibility === 'public';

    if (!isOwner && !isPublic) {
      throw new NotFoundException(`Project ${input.projectId} not found`);
    }

    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      description: row.description ?? null,
      visibility: row.visibility,
      status: row.status,

      coverImageUrl: buildSupabasePublicUrl({
        bucket: row.coverImageBucket,
        objectPath: row.coverImageObjectPath,
      }),

      datasetId: row.datasetId ?? null,
      videoId: row.videoId ?? null,

      videoUrl: buildSupabasePublicUrl({
        bucket: row.videoBucket,
        objectPath: row.videoObjectPath,
      }),
      videoOriginalName: row.videoOriginalName ?? null,
      videoMimeType: row.videoMimeType ?? null,
      videoSizeBytes: row.videoSizeBytes ? Number(row.videoSizeBytes) : null,

      createdAt: row.createdAt,
      updatedAt: row.updatedAt,

      latestPipeline: row.latestPipelineId
        ? {
            id: row.latestPipelineId,
            status: row.latestPipelineStatus,
            progress: row.latestPipelineProgress ?? null,
            currentStage: row.latestPipelineCurrentStage ?? null,
            createdAt: row.latestPipelineCreatedAt,
            updatedAt: row.latestPipelineUpdatedAt,
          }
        : null,
    };
  }

  async updateVisibility(input: {
    projectId: string;
    userId: string;
    visibility: 'public' | 'private';
  }) {
    if (!input.userId) {
      throw new BadRequestException('Missing userId');
    }

    if (input.visibility !== 'public' && input.visibility !== 'private') {
      throw new BadRequestException('Invalid visibility');
    }

    const projectResult = await this.databaseService.query(
      `
    SELECT
      id,
      user_id AS "userId",
      visibility
    FROM projects
    WHERE id = $1
    LIMIT 1
    `,
      [input.projectId],
    );

    const project = projectResult.rows[0];

    if (!project) {
      throw new NotFoundException(`Project ${input.projectId} not found`);
    }

    if (project.userId !== input.userId) {
      throw new ForbiddenException(
        'You do not have permission to update this project',
      );
    }

    const updateResult = await this.databaseService.query(
      `
    UPDATE projects
    SET visibility = $2,
        updated_at = now()
    WHERE id = $1
    RETURNING
      id,
      visibility,
      updated_at AS "updatedAt"
    `,
      [input.projectId, input.visibility],
    );

    return {
      success: true,
      project: {
        id: updateResult.rows[0].id,
        visibility: updateResult.rows[0].visibility,
        updatedAt: updateResult.rows[0].updatedAt,
      },
    };
  }
  async getProjectPlyViewerAssets(projectId: string) {
    const pipelineRows = await this.databaseService.query(
      `
      SELECT
        pr.id AS "pipelineRunId",
        COALESCE(pr.dataset_id, d.id) AS "datasetId",
        pr.video_id AS "videoId",
        pr.result AS "result",

        er.raw_opensfm_run_id AS "rawOpenSfMRunId",
        er.processed_opensfm_run_id AS "processedOpenSfMRunId",

        raw_run.reconstruction_file_id AS "rawReconstructionFileId",
        COALESCE(raw_run.dense_ply_file_id, raw_run.sparse_ply_file_id) AS "rawPlyFileId",

        processed_run.reconstruction_file_id AS "processedReconstructionFileId",
        COALESCE(processed_run.dense_ply_file_id, processed_run.sparse_ply_file_id) AS "processedPlyFileId"

      FROM pipeline_runs pr
      LEFT JOIN datasets d
        ON d.id = pr.dataset_id
      LEFT JOIN evaluation_results er
        ON er.pipeline_run_id = pr.id
      LEFT JOIN opensfm_runs raw_run
        ON raw_run.id = er.raw_opensfm_run_id
      LEFT JOIN opensfm_runs processed_run
        ON processed_run.id = er.processed_opensfm_run_id

      WHERE
        (
          pr.project_id = $1
          OR d.project_id = $1
        )
        AND LOWER(pr.status::text) = 'completed'

      ORDER BY pr.completed_at DESC NULLS LAST, pr.created_at DESC
      LIMIT 1
    `,
      [projectId],
    );

    const pipeline = pipelineRows.rows[0];

    if (!pipeline) {
      return {
        video: null,
        pointClouds: {
          rawPlyUrl: null,
          processedPlyUrl: null,
          rawPlyFileId: null,
          processedPlyFileId: null,
          rawReconstructionFileId: null,
          processedReconstructionFileId: null,
        },
        frames: [],
        message: 'No completed pipeline run found for this project.',
      };
    }

    const result =
      typeof pipeline.result === 'string'
        ? JSON.parse(pipeline.result)
        : (pipeline.result ?? {});

    const rawPlyFileId =
      pipeline.rawPlyFileId ?? result?.rawFlow?.ply?.id ?? null;

    const processedPlyFileId =
      pipeline.processedPlyFileId ?? result?.processedFlow?.ply?.id ?? null;

    const rawReconstructionFileId =
      pipeline.rawReconstructionFileId ??
      result?.rawFlow?.reconstruction?.id ??
      null;

    const processedReconstructionFileId =
      pipeline.processedReconstructionFileId ??
      result?.processedFlow?.reconstruction?.id ??
      null;

    const rawReconstruction = rawReconstructionFileId
      ? await fetchJsonFromDownloadUrl(String(rawReconstructionFileId))
      : null;

    const processedReconstruction = processedReconstructionFileId
      ? await fetchJsonFromDownloadUrl(String(processedReconstructionFileId))
      : null;

    const rawViewpoints = buildShotViewpointMap(rawReconstruction);
    const processedViewpoints = buildShotViewpointMap(processedReconstruction);

    const videoRows = await this.databaseService.query(
      `
      SELECT
        v.id,
        v.original_name AS "originalName",
        v.duration_ms AS "durationMs",
        v.fps,
        v.width,
        v.height,
        sf.id AS "storageFileId"
      FROM videos v
      LEFT JOIN storage_files sf
        ON sf.id = v.storage_file_id
      WHERE v.id = $1
      LIMIT 1
    `,
      [pipeline.videoId],
    );

    const videoRow = videoRows.rows[0] ?? null;

    const frameRows = await this.databaseService.query(
      `
      SELECT
        f.id,
        f.frame_index AS "frameIndex",
        f.timestamp_ms AS "timestampMs",

        raw_sf.id AS "rawFileId",
        raw_sf.original_name AS "rawOriginalName",
        raw_sf.object_path AS "rawObjectPath",

        processed_sf.id AS "processedFileId",
        processed_sf.original_name AS "processedOriginalName",
        processed_sf.object_path AS "processedObjectPath",

        mask_sf.id AS "maskFileId",
        mask_sf.original_name AS "maskOriginalName",
        mask_sf.object_path AS "maskObjectPath"

      FROM frames f
      LEFT JOIN storage_files raw_sf
        ON raw_sf.id = f.raw_storage_file_id
      LEFT JOIN storage_files processed_sf
        ON processed_sf.id = f.processed_storage_file_id
      LEFT JOIN storage_files mask_sf
        ON mask_sf.id = f.mask_storage_file_id
      WHERE f.dataset_id = $1
        AND f.is_selected = true
      ORDER BY f.frame_index ASC
    `,
      [pipeline.datasetId],
    );

    const allFrames = frameRows.rows.map((row: any) => {
      const frameIndex = Number(row.frameIndex);

      const fallbackFrameName = `frame_${String(frameIndex + 1).padStart(
        6,
        '0',
      )}.jpg`;

      const rawFrameName = pickFrameName(row, 'raw') ?? fallbackFrameName;

      const processedFrameName =
        pickFrameName(row, 'processed') ?? rawFrameName ?? fallbackFrameName;

      const maskFrameName = pickFrameName(row, 'mask');

      const rawViewpoint = findViewpoint(rawViewpoints, [
        rawFrameName,
        processedFrameName,
        maskFrameName,
        fallbackFrameName,
      ]);

      const processedViewpoint = findViewpoint(processedViewpoints, [
        processedFrameName,
        rawFrameName,
        maskFrameName,
        fallbackFrameName,
      ]);

      return {
        frameId: row.id,
        frameIndex,
        frameName: rawFrameName,
        timestampMs: Number(row.timestampMs),
        rawImageUrl: storageDownloadUrl(row.rawFileId),
        processedImageUrl: storageDownloadUrl(row.processedFileId),
        maskUrl: storageDownloadUrl(row.maskFileId),
        rawViewpoint,
        processedViewpoint,
        hasRawViewpoint: Boolean(rawViewpoint),
        hasProcessedViewpoint: Boolean(processedViewpoint),
      };
    });

    const frames = allFrames.filter(
      (frame) => frame.rawViewpoint && frame.processedViewpoint,
    );

    return {
      video: videoRow
        ? {
            id: videoRow.id,
            url: storageDownloadUrl(videoRow.storageFileId),
            fps:
              videoRow.fps === null || videoRow.fps === undefined
                ? null
                : Number(videoRow.fps),
            durationMs:
              videoRow.durationMs === null || videoRow.durationMs === undefined
                ? null
                : Number(videoRow.durationMs),
            width:
              videoRow.width === null || videoRow.width === undefined
                ? null
                : Number(videoRow.width),
            height:
              videoRow.height === null || videoRow.height === undefined
                ? null
                : Number(videoRow.height),
            originalName: videoRow.originalName ?? null,
          }
        : null,

      pointClouds: {
        rawPlyUrl: storageDownloadUrl(rawPlyFileId),
        processedPlyUrl: storageDownloadUrl(processedPlyFileId),
        rawPlyFileId,
        processedPlyFileId,
        rawReconstructionFileId,
        processedReconstructionFileId,
      },

      frameStats: {
        totalSelectedFrames: allFrames.length,
        syncedFrames: frames.length,
        rawShotCount: rawViewpoints.size,
        processedShotCount: processedViewpoints.size,
      },

      frames,
    };
  }
}
