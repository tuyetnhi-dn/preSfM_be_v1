import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import { TokenService } from './token.service';

type RegisterBody = {
  email?: string;
  password?: string;
  fullName?: string;
};

type LoginBody = {
  email?: string;
  password?: string;
  userAgent?: string;
  ipAddress?: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly tokenService: TokenService,
  ) {}

  async register(body: RegisterBody) {
    const email = this.normalizeEmail(body.email);
    const password = body.password || '';
    if (password.length < 8) {
      throw new BadRequestException(
        'Password must contain at least 8 characters',
      );
    }
    const passwordHash = this.hashPassword(password);
    const result = await this.databaseService
      .query(
        `INSERT INTO users(email, password_hash, full_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, full_name, role, status, created_at`,
        [email, passwordHash, body.fullName || null],
      )
      .catch((error: { code?: string }) => {
        if (error.code === '23505') {
          throw new BadRequestException('Email already exists');
        }
        throw error;
      });
    return result.rows[0];
  }

  async login(body: LoginBody) {
    const email = this.normalizeEmail(body.email);
    const result = await this.databaseService.query(
      `SELECT id, email, password_hash, full_name, role, status
       FROM users
       WHERE email = $1`,
      [email],
    );
    const user = result.rows[0];
    if (
      !user ||
      user.status !== 'active' ||
      !this.verifyPassword(body.password || '', user.password_hash)
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const accessToken = this.tokenService.createAccessToken({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      userId: user.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      email: user.email,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      role: user.role,
    });
    const refreshToken = this.tokenService.createRefreshToken();
    const refreshTokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const refreshDays = Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 7);
    await this.databaseService.query(
      `INSERT INTO user_sessions(user_id, refresh_token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4::inet, NOW() + ($5 || ' days')::interval)`,
      [
        user.id,
        refreshTokenHash,
        body.userAgent || null,
        body.ipAddress || null,
        refreshDays,
      ],
    );
    await this.databaseService.query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [user.id],
    );
    return {
      accessToken,
      refreshToken,
      user: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        id: user.id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        email: user.email,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        fullName: user.full_name,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        role: user.role,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        status: user.status,
      },
    };
  }

  async refresh(refreshToken?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }
    const refreshTokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const result = await this.databaseService.query(
      `SELECT s.id AS session_id, u.id, u.email, u.full_name, u.role, u.status
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()`,
      [refreshTokenHash],
    );
    const user = result.rows[0];
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const accessToken = this.tokenService.createAccessToken({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      userId: user.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      email: user.email,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      role: user.role,
    });
    return {
      accessToken,
      user: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        id: user.id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        email: user.email,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        fullName: user.full_name,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        role: user.role,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        status: user.status,
      },
    };
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) {
      return { success: true };
    }
    const refreshTokenHash = this.tokenService.hashRefreshToken(refreshToken);
    await this.databaseService.query(
      `UPDATE user_sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [refreshTokenHash],
    );
    return { success: true };
  }

  async me(authorization?: string) {
    const token = this.extractBearerToken(authorization);
    const payload = this.tokenService.verifyAccessToken(token);
    const result = await this.databaseService.query(
      `SELECT id, email, full_name, role, status, created_at
       FROM users
       WHERE id = $1`,
      [payload.sub],
    );
    const user = result.rows[0];
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('User is not active');
    }
    return {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      id: user.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      email: user.email,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      fullName: user.full_name,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      role: user.role,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      status: user.status,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      createdAt: user.created_at,
    };
  }

  private normalizeEmail(email?: string) {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
      throw new BadRequestException('Invalid email');
    }
    return normalized;
  }

  private hashPassword(password: string) {
    const salt = randomBytes(16).toString('hex');
    const hash = pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString(
      'hex',
    );
    return `${salt}:${hash}`;
  }

  private verifyPassword(password: string, stored: string) {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) {
      return false;
    }
    const inputHash = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const storedHash = Buffer.from(hash, 'hex');
    if (inputHash.length !== storedHash.length) {
      return false;
    }
    return timingSafeEqual(inputHash, storedHash);
  }

  private extractBearerToken(authorization?: string) {
    const value = authorization || '';
    if (!value.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token is required');
    }
    return value.slice(7);
  }
}
