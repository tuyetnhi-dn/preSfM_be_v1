import { IsEnum } from 'class-validator';

export enum ProjectVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

export class UpdateVisibilityDto {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  @IsEnum(ProjectVisibility)
  visibility!: ProjectVisibility;
}
