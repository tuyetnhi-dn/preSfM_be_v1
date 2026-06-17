export type ProjectVisibility = 'public' | 'private';

export type ProjectListQuery = {
  scope?: 'public' | 'mine';
  page?: string;
  limit?: string;
  userId?: string;
};

export type LatestPipelineDto = {
  id: string;
  status: string;
  progress: number | null;
  currentStage: string | null;
  createdAt: string;
  updatedAt: string;
} | null;

export type ProjectListItemDto = {
  id: string;
  name: string;
  description: string | null;
  visibility: ProjectVisibility;
  status: string;
  createdAt: string;
  updatedAt: string;
  latestPipeline: LatestPipelineDto;
};

export type PaginatedResponse<T> = {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
};
