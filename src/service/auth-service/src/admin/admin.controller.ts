import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuthService } from '../auth/auth.service';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly authService: AuthService,
  ) {}

  @Get('stats')
  async getStats(@Headers('authorization') authorization?: string) {
    await this.authService.requireManagerRole(authorization);

    return this.adminService.getStats();
  }

  @Get('users')
  async getUsers(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      page?: string;
      limit?: string;
      email?: string;
      role?: string;
      status?: string;
    },
  ) {
    await this.authService.requireManagerRole(authorization);

    return this.adminService.getUsers({
      page: Number(query.page ?? 1),
      limit: Number(query.limit ?? 12),
      email: query.email,
      role: query.role,
      status: query.status,
    });
  }

  @Patch('users/:id/status')
  async updateUserStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
    const adminUser = await this.authService.requireManagerRole(authorization);

    return this.adminService.updateUserStatus({
      currentAdminId: adminUser.id,
      userId: id,
      status: body.status,
    });
  }
  @Get('users/:id')
  async getUserDetail(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Query()
    query: {
      page?: string;
      limit?: string;
    },
  ) {
    await this.authService.requireManagerRole(authorization);

    return this.adminService.getUserDetail({
      userId: id,
      page: Number(query.page ?? 1),
      limit: Number(query.limit ?? 12),
    });
  }

  @Get('projects/:id')
  async getProjectDetail(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    await this.authService.requireManagerRole(authorization);

    return this.adminService.getProjectDetail(id);
  }
  @Get('projects')
  async getProjects(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      page?: string;
      limit?: string;
      search?: string;
      visibility?: string;
      status?: string;
    },
  ) {
    await this.authService.requireManagerRole(authorization);

    return this.adminService.getProjects({
      page: Number(query.page ?? 1),
      limit: Number(query.limit ?? 12),
      search: query.search,
      visibility: query.visibility,
      status: query.status,
    });
  }
}
