/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { TokenService } from './token.service'; // Sửa lại đường dẫn import

@Injectable()
export class AdminService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly tokenService: TokenService,
  ) {}

  // ─── Lấy Thống Kê ───────────────────────────────────────────────────────────
  async getStats(authorization?: string) {
    this.verifyAdminToken(authorization);

    const totalUsers = await this.databaseService.query(
      `SELECT COUNT(*) as count FROM users`,
    );
    const activeUsers = await this.databaseService.query(
      `SELECT COUNT(*) as count FROM users WHERE status = 'active'`,
    );
    const lockedUsers = await this.databaseService.query(
      `SELECT COUNT(*) as count FROM users WHERE status = 'locked'`,
    );

    return {
      total: parseInt(totalUsers.rows[0]['count'] as string, 10),
      active: parseInt(activeUsers.rows[0]['count'] as string, 10),
      locked: parseInt(lockedUsers.rows[0]['count'] as string, 10),
    };
  }

  // ─── Lấy Danh Sách User ─────────────────────────────────────────────────────
  async getUsers(authorization?: string, page = 1, limit = 10, search = '') {
    this.verifyAdminToken(authorization);

    const offset = (page - 1) * limit;
    const query = `
      SELECT id, email, full_name, role, status, created_at 
      FROM users 
      WHERE email ILIKE $1 OR full_name ILIKE $1
      ORDER BY created_at DESC 
      LIMIT $2 OFFSET $3
    `;
    const users = await this.databaseService.query(query, [
      `%${search}%`,
      limit,
      offset,
    ]);

    const countQuery = `SELECT COUNT(*) as count FROM users WHERE email ILIKE $1 OR full_name ILIKE $1`;
    const totalResult = await this.databaseService.query(countQuery, [
      `%${search}%`,
    ]);
    const total = parseInt(totalResult.rows[0]['count'] as string, 10);

    return {
      data: users.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── Khóa / Mở Khóa Tài Khoản ───────────────────────────────────────────────
  async toggleUserStatus(userId: string, authorization?: string) {
    this.verifyAdminToken(authorization);

    const result = await this.databaseService.query(
      `SELECT status FROM users WHERE id = $1`,
      [userId],
    );
    const user = result.rows[0] as { status: string } | undefined;

    if (!user) throw new BadRequestException('Người dùng không tồn tại');

    const newStatus = user.status === 'active' ? 'locked' : 'active';

    await this.databaseService.query(
      `UPDATE users SET status = $1 WHERE id = $2`,
      [newStatus, userId],
    );

    // Nếu khóa, thu hồi session
    if (newStatus === 'locked') {
      await this.databaseService.query(
        `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    }

    return {
      message: `Tài khoản đã được ${newStatus === 'locked' ? 'khóa' : 'mở khóa'}`,
      newStatus,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────
  private verifyAdminToken(authorization?: string): string {
    const value = authorization ?? '';
    if (!value.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token là bắt buộc');
    }
    const token = value.slice(7);
    const payload = this.tokenService.verifyAccessToken(token);

    if (payload.role !== 'admin') {
      throw new ForbiddenException('Bạn không có quyền truy cập chức năng này');
    }

    return payload.sub;
  }
}
