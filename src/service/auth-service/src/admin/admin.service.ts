/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

type GetAdminUsersInput = {
  page: number;
  limit: number;
  email?: string;
  role?: string;
  status?: string;
};

@Injectable()
export class AdminService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getStats() {
    const statsResult = await this.databaseService.query(
      `
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,

        (SELECT COUNT(*) FROM projects) AS total_projects,
        (SELECT COUNT(*) FROM projects WHERE visibility = 'public') AS public_projects,
        (SELECT COUNT(*) FROM projects WHERE visibility = 'private') AS private_projects,

        (SELECT COUNT(*) FROM pipeline_runs) AS total_pipelines,
        (SELECT COUNT(*) FROM pipeline_runs WHERE status = 'running') AS running_pipelines,
        (SELECT COUNT(*) FROM pipeline_runs WHERE status = 'completed') AS completed_pipelines,
        (SELECT COUNT(*) FROM pipeline_runs WHERE status = 'failed') AS failed_pipelines
      `,
    );

    const topUsersResult = await this.databaseService.query(
      `
      SELECT
        u.id,
        u.email,
        u.full_name,
        COALESCE(COUNT(DISTINCT p.id), 0)::int AS project_count,
        COALESCE(COUNT(DISTINCT v.id), 0)::int AS video_count,
        COALESCE(COUNT(DISTINCT pr.id), 0)::int AS pipeline_run_count
      FROM users u
      LEFT JOIN projects p ON p.user_id = u.id
      LEFT JOIN datasets d ON d.project_id = p.id
      LEFT JOIN videos v ON v.dataset_id = d.id
      LEFT JOIN pipeline_runs pr ON pr.video_id = v.id
      GROUP BY u.id, u.email, u.full_name
      ORDER BY pipeline_run_count DESC, project_count DESC, video_count DESC
      LIMIT 5
      `,
    );

    const row = statsResult.rows[0] as Record<string, string | number>;

    return {
      totalUsers: Number(row.total_users ?? 0),
      activeUsers: Number(row.active_users ?? 0),

      totalProjects: Number(row.total_projects ?? 0),
      publicProjects: Number(row.public_projects ?? 0),
      privateProjects: Number(row.private_projects ?? 0),

      totalPipelines: Number(row.total_pipelines ?? 0),
      runningPipelines: Number(row.running_pipelines ?? 0),
      completedPipelines: Number(row.completed_pipelines ?? 0),
      failedPipelines: Number(row.failed_pipelines ?? 0),

      topUsers: topUsersResult.rows.map((user) => ({
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        projectCount: Number(user.project_count ?? 0),
        videoCount: Number(user.video_count ?? 0),
        pipelineRunCount: Number(user.pipeline_run_count ?? 0),
      })),
    };
  }

  async getUsers(input: GetAdminUsersInput) {
    const page = Number.isFinite(input.page) && input.page > 0 ? input.page : 1;

    const limit =
      Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(input.limit, 100)
        : 12;

    const offset = (page - 1) * limit;

    const whereParts: string[] = [];
    const params: unknown[] = [];

    const email = input.email?.trim();

    if (email) {
      if (email.includes('@')) {
        params.push(email.toLowerCase());
        whereParts.push(`lower(u.email) = $${params.length}`);
      } else {
        params.push(`%${email}%`);
        whereParts.push(`u.email ILIKE $${params.length}`);
      }
    }

    if (input.role?.trim() && input.role !== 'all') {
      params.push(input.role.trim());
      whereParts.push(`u.role::text = $${params.length}`);
    }

    if (input.status?.trim() && input.status !== 'all') {
      params.push(input.status.trim());
      whereParts.push(`u.status::text = $${params.length}`);
    }

    const whereSql =
      whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const countResult = await this.databaseService.query(
      `
    SELECT COUNT(*)::int AS total
    FROM users u
    ${whereSql}
    `,
      params,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);

    const listParams = [...params, limit, offset];
    const limitIndex = params.length + 1;
    const offsetIndex = params.length + 2;

    const usersResult = await this.databaseService.query(
      `
    SELECT
      u.id,
      u.email,
      u.full_name,
      u.role::text AS role,
      u.status::text AS status,
      u.created_at,
      COALESCE(COUNT(DISTINCT p.id), 0)::int AS project_count
    FROM users u
    LEFT JOIN projects p ON p.user_id = u.id
    ${whereSql}
    GROUP BY
      u.id,
      u.email,
      u.full_name,
      u.role,
      u.status,
      u.created_at
    ORDER BY u.created_at DESC, u.id ASC
    LIMIT $${limitIndex}
    OFFSET $${offsetIndex}
    `,
      listParams,
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items: usersResult.rows.map((user) => ({
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        status: user.status,
        projectCount: Number(user.project_count ?? 0),
        createdAt: user.created_at,
      })),
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }
  async updateUserStatus(input: {
    currentAdminId: string;
    userId: string;
    status?: string;
  }) {
    const status = input.status?.trim().toLowerCase();

    if (!status) {
      throw new BadRequestException('Status is required');
    }

    const allowedStatuses = ['active', 'blocked'];

    if (!allowedStatuses.includes(status)) {
      throw new BadRequestException('Invalid account status');
    }

    if (input.currentAdminId === input.userId) {
      throw new BadRequestException(
        'You cannot change your own account status',
      );
    }

    const result = await this.databaseService.query(
      `
      UPDATE users
      SET status = $1::user_status,
          updated_at = now()
      WHERE id = $2
      RETURNING
        id,
        email,
        full_name,
        role::text AS role,
        status::text AS status,
        created_at
      `,
      [status, input.userId],
    );

    const user = result.rows[0];

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (status === 'blocked') {
      await this.databaseService.query(
        `
        UPDATE user_sessions
        SET revoked_at = now()
        WHERE user_id = $1
          AND revoked_at IS NULL
        `,
        [input.userId],
      );
    }

    return {
      message:
        status === 'blocked'
          ? 'User account has been locked'
          : 'User account has been unlocked',
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
      },
    };
  }
  async getUserDetail(input: { userId: string; page: number; limit: number }) {
    const page = Number.isFinite(input.page) && input.page > 0 ? input.page : 1;

    const limit =
      Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(input.limit, 100)
        : 12;

    const offset = (page - 1) * limit;

    const userResult = await this.databaseService.query(
      `
    SELECT
      u.id,
      u.email,
      u.full_name,
      u.role::text AS role,
      u.status::text AS status,
      u.created_at,
      u.updated_at,
      COALESCE(COUNT(DISTINCT p.id), 0)::int AS project_count,
      COALESCE(COUNT(DISTINCT d.id), 0)::int AS dataset_count,
      COALESCE(COUNT(DISTINCT v.id), 0)::int AS video_count,
      COALESCE(COUNT(DISTINCT pr.id), 0)::int AS pipeline_run_count,
      COALESCE(
        COUNT(DISTINCT pr.id) FILTER (WHERE pr.status::text = 'failed'),
        0
      )::int AS failed_pipeline_count
    FROM users u
    LEFT JOIN projects p ON p.user_id = u.id
    LEFT JOIN datasets d ON d.project_id = p.id
    LEFT JOIN videos v ON v.dataset_id = d.id
    LEFT JOIN pipeline_runs pr ON pr.dataset_id = d.id
    WHERE u.id = $1
    GROUP BY
      u.id,
      u.email,
      u.full_name,
      u.role,
      u.status,
      u.created_at,
      u.updated_at
    `,
      [input.userId],
    );

    const user = userResult.rows[0];

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const countResult = await this.databaseService.query(
      `
    SELECT COUNT(*)::int AS total
    FROM projects p
    WHERE p.user_id = $1
    `,
      [input.userId],
    );

    const total = Number(countResult.rows[0]?.total ?? 0);

    const projectsResult = await this.databaseService.query(
      `
    SELECT
      p.id,
      p.name,
      p.description,
      p.status::text AS status,
      p.visibility,
      p.created_at,
      p.updated_at,
      COALESCE(COUNT(DISTINCT d.id), 0)::int AS dataset_count,
      COALESCE(COUNT(DISTINCT v.id), 0)::int AS video_count,
      COALESCE(COUNT(DISTINCT pr.id), 0)::int AS pipeline_run_count,
      COALESCE(
        COUNT(DISTINCT pr.id) FILTER (WHERE pr.status::text = 'failed'),
        0
      )::int AS failed_pipeline_count
    FROM projects p
    LEFT JOIN datasets d ON d.project_id = p.id
    LEFT JOIN videos v ON v.dataset_id = d.id
    LEFT JOIN pipeline_runs pr ON pr.dataset_id = d.id
    WHERE p.user_id = $1
    GROUP BY
      p.id,
      p.name,
      p.description,
      p.status,
      p.visibility,
      p.created_at,
      p.updated_at
    ORDER BY p.created_at DESC, p.id ASC
    LIMIT $2
    OFFSET $3
    `,
      [input.userId, limit, offset],
    );

    const totalPages = Math.ceil(total / limit);

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        projectCount: Number(user.project_count ?? 0),
        datasetCount: Number(user.dataset_count ?? 0),
        videoCount: Number(user.video_count ?? 0),
        pipelineRunCount: Number(user.pipeline_run_count ?? 0),
        failedPipelineCount: Number(user.failed_pipeline_count ?? 0),
      },
      projects: {
        items: projectsResult.rows.map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          visibility: project.visibility,
          datasetCount: Number(project.dataset_count ?? 0),
          videoCount: Number(project.video_count ?? 0),
          pipelineRunCount: Number(project.pipeline_run_count ?? 0),
          failedPipelineCount: Number(project.failed_pipeline_count ?? 0),
          createdAt: project.created_at,
          updatedAt: project.updated_at,
        })),
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
      },
    };
  }
  async getProjectDetail(projectId: string) {
    const projectResult = await this.databaseService.query(
      `
    SELECT
      p.id,
      p.name,
      p.description,
      p.status::text AS status,
      p.visibility,
      p.created_at,
      p.updated_at,
      u.id AS owner_id,
      u.email AS owner_email,
      u.full_name AS owner_full_name,
      COALESCE(COUNT(DISTINCT d.id), 0)::int AS dataset_count,
      COALESCE(COUNT(DISTINCT v.id), 0)::int AS video_count,
      COALESCE(COUNT(DISTINCT pr.id), 0)::int AS pipeline_run_count,
      COALESCE(
        COUNT(DISTINCT pr.id) FILTER (WHERE pr.status::text = 'failed'),
        0
      )::int AS failed_pipeline_count
    FROM projects p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN datasets d ON d.project_id = p.id
    LEFT JOIN videos v ON v.dataset_id = d.id
    LEFT JOIN pipeline_runs pr ON pr.dataset_id = d.id
    WHERE p.id = $1
    GROUP BY
      p.id,
      p.name,
      p.description,
      p.status,
      p.visibility,
      p.created_at,
      p.updated_at,
      u.id,
      u.email,
      u.full_name
    `,
      [projectId],
    );

    const project = projectResult.rows[0];

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const datasetsResult = await this.databaseService.query(
      `
    SELECT
      d.id,
      d.created_at
    FROM datasets d
    WHERE d.project_id = $1
    ORDER BY d.created_at DESC
    `,
      [projectId],
    );

    const videosResult = await this.databaseService.query(
      `
    SELECT
      v.id,
      v.dataset_id,
      v.storage_file_id
    FROM videos v
    INNER JOIN datasets d ON d.id = v.dataset_id
    WHERE d.project_id = $1
    ORDER BY v.id ASC
    `,
      [projectId],
    );

    const pipelinesResult = await this.databaseService.query(
      `
    SELECT
      pr.id,
      pr.dataset_id,
      pr.video_id,
      pr.project_id,
      pr.status::text AS status,
      pr.progress,
      pr.pipeline_type,
      pr.stage,
      pr.current_stage,
      pr.created_at,
      pr.updated_at
    FROM pipeline_runs pr
    LEFT JOIN datasets d ON d.id = pr.dataset_id
    WHERE d.project_id = $1 OR pr.project_id = $1
    ORDER BY pr.created_at DESC
    LIMIT 50
    `,
      [projectId],
    );

    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        visibility: project.visibility,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
        owner: {
          id: project.owner_id,
          email: project.owner_email,
          fullName: project.owner_full_name,
        },
        datasetCount: Number(project.dataset_count ?? 0),
        videoCount: Number(project.video_count ?? 0),
        pipelineRunCount: Number(project.pipeline_run_count ?? 0),
        failedPipelineCount: Number(project.failed_pipeline_count ?? 0),
      },
      datasets: datasetsResult.rows.map((dataset) => ({
        id: dataset.id,
        createdAt: dataset.created_at,
      })),
      videos: videosResult.rows.map((video) => ({
        id: video.id,
        datasetId: video.dataset_id,
        storageFileId: video.storage_file_id,
      })),
      pipelines: pipelinesResult.rows.map((pipeline) => ({
        id: pipeline.id,
        datasetId: pipeline.dataset_id,
        videoId: pipeline.video_id,
        projectId: pipeline.project_id,
        status: pipeline.status,
        progress: Number(pipeline.progress ?? 0),
        pipelineType: pipeline.pipeline_type,
        stage: pipeline.stage,
        currentStage: pipeline.current_stage,
        createdAt: pipeline.created_at,
        updatedAt: pipeline.updated_at,
      })),
    };
  }
  async getProjects(input: {
    page: number;
    limit: number;
    search?: string;
    visibility?: string;
    status?: string;
  }) {
    const page = Number.isFinite(input.page) && input.page > 0 ? input.page : 1;

    const limit =
      Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(input.limit, 100)
        : 12;

    const offset = (page - 1) * limit;

    const whereParts: string[] = [];
    const params: unknown[] = [];

    const search = input.search?.trim();

    if (search) {
      params.push(`%${search}%`);
      whereParts.push(`p.name ILIKE $${params.length}`);
    }

    if (input.visibility?.trim() && input.visibility !== 'all') {
      params.push(input.visibility.trim());
      whereParts.push(`p.visibility = $${params.length}`);
    }

    if (input.status?.trim() && input.status !== 'all') {
      params.push(input.status.trim());
      whereParts.push(`p.status::text = $${params.length}`);
    }

    const whereSql =
      whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const countResult = await this.databaseService.query(
      `
    SELECT COUNT(*)::int AS total
    FROM projects p
    ${whereSql}
    `,
      params,
    );

    const total = Number(countResult.rows[0]?.total ?? 0);

    const listParams = [...params, limit, offset];
    const limitIndex = params.length + 1;
    const offsetIndex = params.length + 2;

    const projectsResult = await this.databaseService.query(
      `
    SELECT
      p.id,
      p.name,
      p.description,
      p.status::text AS status,
      p.visibility,
      p.created_at,
      p.updated_at,

      u.id AS owner_id,
      u.email AS owner_email,
      u.full_name AS owner_full_name,

      COALESCE(COUNT(DISTINCT d.id), 0)::int AS dataset_count,
      COALESCE(COUNT(DISTINCT v.id), 0)::int AS video_count,
      COALESCE(COUNT(DISTINCT pr.id), 0)::int AS pipeline_run_count,
      COALESCE(
        COUNT(DISTINCT pr.id) FILTER (WHERE pr.status::text = 'failed'),
        0
      )::int AS failed_pipeline_count
    FROM projects p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN datasets d ON d.project_id = p.id
    LEFT JOIN videos v ON v.dataset_id = d.id
    LEFT JOIN pipeline_runs pr ON pr.dataset_id = d.id
    ${whereSql}
    GROUP BY
      p.id,
      p.name,
      p.description,
      p.status,
      p.visibility,
      p.created_at,
      p.updated_at,
      u.id,
      u.email,
      u.full_name
    ORDER BY p.created_at DESC, p.id ASC
    LIMIT $${limitIndex}
    OFFSET $${offsetIndex}
    `,
      listParams,
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items: projectsResult.rows.map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        visibility: project.visibility,
        owner: {
          id: project.owner_id,
          email: project.owner_email,
          fullName: project.owner_full_name,
        },
        datasetCount: Number(project.dataset_count ?? 0),
        videoCount: Number(project.video_count ?? 0),
        pipelineRunCount: Number(project.pipeline_run_count ?? 0),
        failedPipelineCount: Number(project.failed_pipeline_count ?? 0),
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      })),
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }
}
