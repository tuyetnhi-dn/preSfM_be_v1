import { Controller, Get, Headers, Param, Patch, Query } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin') // URL sẽ bắt đầu bằng /admin thay vì /auth/admin để API đẹp hơn
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  getStats(@Headers('authorization') authorization?: string) {
    return this.adminService.getStats(authorization);
  }

  @Get('users')
  getUsers(
    @Headers('authorization') authorization?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getUsers(
      authorization,
      page ? Number(page) : 1,
      limit ? Number(limit) : 10,
      search ?? '',
    );
  }

  @Patch('users/:id/toggle-status')
  toggleUserStatus(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    return this.adminService.toggleUserStatus(id, authorization);
  }
}
