export type ProjectVisibility = 'public' | 'private';

export type UploadBody = {
  datasetId?: string;
  uploadedBy?: string;
  projectName?: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  visibility?: ProjectVisibility | string;
  datasetName?: string;
};
export type UpdateProjectVisibilityDto = {
  visibility: 'public' | 'private';
};
