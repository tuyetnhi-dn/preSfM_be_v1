import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import { TokenService } from './token.service';

// ─── Types ────────────────────────────────────────────────────────────────────

type RegisterBody = {
  email?: string;
  password?: string;
  otp?: string;
  fullName?: string;
};

type LoginBody = {
  email?: string;
  password?: string;
  userAgent?: string;
  ipAddress?: string;
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly tokenService: TokenService,
  ) {}

  // ─── OTP ────────────────────────────────────────────────────────────────────

  /**
   * Tạo OTP 6 chữ số, lưu hash vào DB, gửi email cho user.
   * Mỗi lần gọi sẽ xóa các OTP cũ chưa dùng của email đó.
   */
  async sendOtp(body: { email?: string }) {
    const email = this.normalizeEmail(body.email);
    const otp = this.generateOtp();
    const otpHash = this.hashOtp(otp);
    const expiresMinutes = Number(process.env.OTP_EXPIRES_MINUTES ?? 10);

    // Xóa OTP cũ chưa dùng của email này
    await this.databaseService.query(
      `DELETE FROM email_otps WHERE email = $1 AND used_at IS NULL`,
      [email],
    );

    // Lưu OTP mới
    await this.databaseService.query(
      `INSERT INTO email_otps (email, otp_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
      [email, otpHash, expiresMinutes],
    );

    // Gửi email
    await this.sendOtpEmail(email, otp, expiresMinutes);

    return { message: 'OTP đã được gửi tới email của bạn' };
  }

  // ─── Register ───────────────────────────────────────────────────────────────

  /**
   * Đăng ký tài khoản mới sau khi xác thực OTP.
   */
  async register(body: RegisterBody) {
    const { password = '', otp = '', fullName } = body;
    const email = this.normalizeEmail(body.email);

    if (!otp) throw new BadRequestException('OTP là bắt buộc');
    if (password.length < 8) {
      throw new BadRequestException('Mật khẩu phải có ít nhất 8 ký tự');
    }

    // Bước 1: Verify OTP từ DB
    await this.verifyOtp(email, otp);

    // Bước 2: Tạo user
    const passwordHash = this.hashPassword(password);
    const result = await this.databaseService
      .query(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, full_name, role, status, created_at`,
        [email, passwordHash, fullName ?? null],
      )
      .catch((error: { code?: string }) => {
        if (error.code === '23505') {
          throw new BadRequestException('Email đã được sử dụng');
        }
        throw error;
      });

    // Bước 3: Đánh dấu OTP đã dùng
    await this.markOtpUsed(email);

    const user = result.rows[0] as Record<string, unknown>;
    return {
      message: 'Đăng ký thành công',
      user: {
        id: user['id'],
        email: user['email'],
        fullName: user['full_name'],
        role: user['role'],
        status: user['status'],
        createdAt: user['created_at'],
      },
    };
  }

  // ─── Login ──────────────────────────────────────────────────────────────────

  async login(body: LoginBody) {
    const email = this.normalizeEmail(body.email);

    const result = await this.databaseService.query(
      `SELECT id, email, password_hash, full_name, role, status
       FROM users
       WHERE email = $1`,
      [email],
    );

    const user = result.rows[0] as Record<string, unknown> | undefined;

    if (
      !user ||
      user['status'] !== 'active' ||
      !this.verifyPassword(body.password ?? '', user['password_hash'] as string)
    ) {
      throw new UnauthorizedException('Email hoặc mật khẩu không chính xác');
    }

    const accessToken = this.tokenService.createAccessToken({
      userId: user['id'] as string,
      email: user['email'] as string,
      role: user['role'] as string,
    });
    const refreshToken = this.tokenService.createRefreshToken();
    const refreshTokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const refreshDays = Number(process.env.JWT_REFRESH_EXPIRES_DAYS ?? 7);

    await this.databaseService.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4::inet, NOW() + ($5 || ' days')::interval)`,
      [
        user['id'],
        refreshTokenHash,
        body.userAgent ?? null,
        body.ipAddress ?? null,
        refreshDays,
      ],
    );

    await this.databaseService.query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [user['id']],
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id: user['id'],
        email: user['email'],
        fullName: user['full_name'],
        role: user['role'],
        status: user['status'],
      },
    };
  }

  // ─── Refresh ─────────────────────────────────────────────────────────────────

  async refresh(refreshToken?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token là bắt buộc');
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

    const user = result.rows[0] as Record<string, unknown> | undefined;

    if (!user || user['status'] !== 'active') {
      throw new UnauthorizedException(
        'Refresh token không hợp lệ hoặc đã hết hạn',
      );
    }

    const accessToken = this.tokenService.createAccessToken({
      userId: user['id'] as string,
      email: user['email'] as string,
      role: user['role'] as string,
    });

    return {
      accessToken,
      user: {
        id: user['id'],
        email: user['email'],
        fullName: user['full_name'],
        role: user['role'],
        status: user['status'],
      },
    };
  }

  // ─── Logout ──────────────────────────────────────────────────────────────────

  async logout(refreshToken?: string) {
    if (!refreshToken) {
      return { success: true };
    }

    const refreshTokenHash = this.tokenService.hashRefreshToken(refreshToken);

    await this.databaseService.query(
      `UPDATE user_sessions
       SET revoked_at = NOW()
       WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [refreshTokenHash],
    );

    return { success: true };
  }

  // ─── Me ──────────────────────────────────────────────────────────────────────

  async me(authorization?: string) {
    const token = this.extractBearerToken(authorization);
    const payload = this.tokenService.verifyAccessToken(token);

    const result = await this.databaseService.query(
      `SELECT id, email, full_name, role, status, created_at
       FROM users
       WHERE id = $1`,
      [payload.sub],
    );

    const user = result.rows[0] as Record<string, unknown> | undefined;

    if (!user || user['status'] !== 'active') {
      throw new UnauthorizedException('Người dùng không tồn tại hoặc bị khóa');
    }

    return {
      id: user['id'],
      email: user['email'],
      fullName: user['full_name'],
      role: user['role'],
      status: user['status'],
      createdAt: user['created_at'],
    };
  }

  // ─── Private: OTP helpers ────────────────────────────────────────────────────

  /** Tạo OTP 6 chữ số ngẫu nhiên */
  private generateOtp(): string {
    const num = parseInt(randomBytes(3).toString('hex'), 16) % 1_000_000;
    return num.toString().padStart(6, '0');
  }

  /** Hash OTP bằng SHA-256 để lưu DB (không cần salt vì OTP tồn tại ngắn) */
  private hashOtp(otp: string): string {
    return pbkdf2Sync(otp, 'otp-salt', 10_000, 32, 'sha256').toString('hex');
  }

  /**
   * Kiểm tra OTP: tìm bản ghi hợp lệ (chưa dùng, chưa hết hạn),
   * so sánh hash. Throw nếu không hợp lệ.
   */
  private async verifyOtp(email: string, otp: string): Promise<void> {
    const result = await this.databaseService.query(
      `SELECT id, otp_hash FROM email_otps
       WHERE email = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [email],
    );

    const record = result.rows[0] as
      | { id: string; otp_hash: string }
      | undefined;

    if (!record) {
      throw new BadRequestException('OTP không hợp lệ hoặc đã hết hạn');
    }

    const inputHash = Buffer.from(this.hashOtp(otp), 'hex');
    const storedHash = Buffer.from(record.otp_hash, 'hex');

    if (
      inputHash.length !== storedHash.length ||
      !timingSafeEqual(inputHash, storedHash)
    ) {
      throw new BadRequestException('OTP không chính xác');
    }
  }

  /** Đánh dấu OTP đã được sử dụng */
  private async markOtpUsed(email: string): Promise<void> {
    await this.databaseService.query(
      `UPDATE email_otps
       SET used_at = NOW()
       WHERE email = $1 AND used_at IS NULL`,
      [email],
    );
  }

  /** Gửi email chứa mã OTP qua SMTP */
  private async sendOtpEmail(
    email: string,
    otp: string,
    expiresMinutes: number,
  ): Promise<void> {
    this.logger.log(`[SMTP] Đang gửi OTP tới ${email}`);
    this.logger.log(
      `[SMTP] Host: ${process.env.SMTP_HOST}, Port: ${process.env.SMTP_PORT}`,
    );
    this.logger.log(`[SMTP] User: ${process.env.SMTP_USER}`);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const transporter = createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access

      const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const info = await transporter.sendMail({
        from: process.env.SMTP_FROM ?? 'PreSFM <no-reply@presfm.com>',
        to: email,
        subject: 'Mã xác thực OTP - PreSFM',
        html: `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 2rem auto; padding: 2rem; border: 1px solid #e5e7eb; border-radius: 12px;">
      
      <h2 style="text-align:center; color:#111827;">
        Xác thực tài khoản của bạn
      </h2>

      <p style="text-align:center; color:#4b5563;">
        Vui lòng sử dụng mã OTP dưới đây để xác thực tài khoản.
      </p>

      <div style="margin: 1.5rem 0; padding: 1.5rem; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:8px; text-align:center;">
        <p style="color:#64748b; font-size:12px; font-weight:600;">
          Mã xác thực OTP của bạn
        </p>

        <div style="font-size:42px; font-weight:800; letter-spacing:8px; color:#1e40af;">
          ${otp}
        </div>
      </div>

      <div style="text-align:center; margin: 2rem 0; padding: 1rem; background:#fffbeb; border-radius:8px;">
        <p style="color:#b45309; font-size:13px; font-weight:600;">
          Mã OTP sẽ hết hạn sau:
        </p>

        <div style="font-size:28px; font-weight:800; color:#b45309;">
          ${expiresMinutes} phút
        </div>

        <p style="color:#92400e; font-size:12px;">
          Hết hạn lúc: ${expiresAt.toLocaleTimeString('vi-VN')}
        </p>
      </div>

      <p style="color:#9ca3af; font-size:12px; text-align:center;">
        Vì lý do bảo mật, tuyệt đối không chia sẻ mã này với bất kỳ ai.
        Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này an toàn.
      </p>

    </div>
  `,
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      this.logger.log(`[SMTP] Gửi thành công: ${info.messageId}`);
    } catch (error) {
      this.logger.error(`[SMTP] Lỗi gửi mail tới ${email}`, error);
      throw new InternalServerErrorException(
        'Không thể gửi email, vui lòng thử lại',
      );
    }
  }

  // ─── Private: Password helpers ───────────────────────────────────────────────

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString(
      'hex',
    );
    return `${salt}:${hash}`;
  }

  private verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;

    const inputHash = pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
    const storedHash = Buffer.from(hash, 'hex');

    if (inputHash.length !== storedHash.length) return false;
    return timingSafeEqual(inputHash, storedHash);
  }

  // ─── Private: Token helpers ──────────────────────────────────────────────────

  private normalizeEmail(email?: string): string {
    const normalized = (email ?? '').trim().toLowerCase();
    if (!normalized.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
      throw new BadRequestException('Email không hợp lệ');
    }
    return normalized;
  }

  private extractBearerToken(authorization?: string): string {
    const value = authorization ?? '';
    if (!value.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token là bắt buộc');
    }
    return value.slice(7);
  }
  // ─── Change Password ─────────────────────────────────────────────────────────

  async changePassword(
    userId: string,
    body: {
      oldPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    },
  ) {
    const { oldPassword = '', newPassword = '', confirmPassword = '' } = body;

    if (newPassword.length < 8) {
      throw new BadRequestException('Mật khẩu mới phải có ít nhất 8 ký tự');
    }
    if (newPassword !== confirmPassword) {
      throw new BadRequestException('Mật khẩu xác nhận không khớp');
    }

    // 1. Lấy thông tin user hiện tại
    const result = await this.databaseService.query(
      `SELECT id, password_hash FROM users WHERE id = $1 AND status = 'active'`,
      [userId],
    );
    const user = result.rows[0] as Record<string, unknown> | undefined;

    if (!user) {
      throw new UnauthorizedException('Người dùng không tồn tại hoặc bị khóa');
    }

    // 2. Kiểm tra mật khẩu cũ
    if (!this.verifyPassword(oldPassword, user['password_hash'] as string)) {
      throw new BadRequestException('Mật khẩu cũ không chính xác');
    }

    // 3. Cập nhật mật khẩu mới
    const newPasswordHash = this.hashPassword(newPassword);
    await this.databaseService.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newPasswordHash, userId],
    );

    // 4. (Tùy chọn) Xóa tất cả các session cũ để bắt buộc đăng nhập lại trên các thiết bị
    await this.databaseService.query(
      `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );

    return { message: 'Đổi mật khẩu thành công, vui lòng đăng nhập lại' };
  }

  // ─── Forgot Password ─────────────────────────────────────────────────────────

  async forgotPassword(body: { email?: string; locale?: string }) {
    const email = this.normalizeEmail(body.email);

    // Xử lý locale (Mặc định là 'vi' nếu không truyền hoặc truyền sai)
    const supportedLocales = ['vi', 'en'];
    const locale = supportedLocales.includes(body.locale ?? '')
      ? body.locale
      : 'vi';

    // 1. Kiểm tra user có tồn tại và đang active không
    const userResult = await this.databaseService.query(
      `SELECT id, status FROM users WHERE email = $1`,
      [email],
    );
    const user = userResult.rows[0] as Record<string, unknown> | undefined;

    if (!user || user['status'] !== 'active') {
      throw new BadRequestException(
        'Email không tồn tại hoặc tài khoản bị khóa',
      );
    }

    // 2. Clear token (Thu hồi session)
    await this.databaseService.query(
      `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [user['id']],
    );

    // 3. Tạo Reset Token
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashResetToken(rawToken);
    const expiresMinutes = Number(process.env.RESET_EXPIRES_MINUTES ?? 15);

    // 4. Xóa token cũ & Lưu token mới
    await this.databaseService.query(
      `DELETE FROM password_resets WHERE email = $1 AND used_at IS NULL`,
      [email],
    );
    await this.databaseService.query(
      `INSERT INTO password_resets (email, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
      [email, tokenHash, expiresMinutes],
    );

    // 5. Nối chuỗi URL khôi phục chính xác với cấu trúc FE của bạn
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';

    // Kết quả sẽ ra dạng: http://localhost:3000/vi/auth/reset-password?token=xxxxxx
    const resetLink = `${frontendUrl}/${locale}/auth/reset-password?token=${rawToken}`;

    await this.sendResetPasswordEmail(email, resetLink, expiresMinutes);

    return { message: 'Link khôi phục mật khẩu đã được gửi đến email của bạn' };
  }

  // ─── Reset Password ──────────────────────────────────────────────────────────

  async resetPassword(body: { token?: string; newPassword?: string }) {
    const { token = '', newPassword = '' } = body;

    if (!token) throw new BadRequestException('Token không hợp lệ');
    if (newPassword.length < 8) {
      throw new BadRequestException('Mật khẩu mới phải có ít nhất 8 ký tự');
    }

    const tokenHash = this.hashResetToken(token);

    // 1. Kiểm tra token trong DB
    const result = await this.databaseService.query(
      `SELECT id, email FROM password_resets
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash],
    );

    const record = result.rows[0] as { id: string; email: string } | undefined;

    if (!record) {
      throw new BadRequestException(
        'Link khôi phục không hợp lệ hoặc đã hết hạn',
      );
    }

    // 2. Hash password mới và cập nhật user
    const newPasswordHash = this.hashPassword(newPassword);
    await this.databaseService.query(
      `UPDATE users SET password_hash = $1 WHERE email = $2`,
      [newPasswordHash, record.email],
    );

    // 3. Đánh dấu token đã được sử dụng
    await this.databaseService.query(
      `UPDATE password_resets SET used_at = NOW() WHERE id = $1`,
      [record.id],
    );

    // 4. (Tùy chọn) Clear lại session lần nữa để chắc chắn
    await this.databaseService.query(
      `UPDATE user_sessions
       SET revoked_at = NOW()
       WHERE user_id = (SELECT id FROM users WHERE email = $1)
         AND revoked_at IS NULL`,
      [record.email],
    );

    return {
      message: 'Mật khẩu đã được đặt lại thành công. Bạn có thể đăng nhập.',
    };
  }

  // ─── Private Helpers for Reset Password ──────────────────────────────────────

  /** Hash reset token để lưu DB */
  private hashResetToken(token: string): string {
    return pbkdf2Sync(token, 'reset-token-salt', 10_000, 32, 'sha256').toString(
      'hex',
    );
  }

  /** Gửi email Link Reset Password qua SMTP */
  private async sendResetPasswordEmail(
    email: string,
    resetLink: string,
    expiresMinutes: number,
  ): Promise<void> {
    this.logger.log(`[SMTP] Đang gửi Reset Link tới ${email}`);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const transporter = createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM ?? 'PreSFM <no-reply@presfm.com>',
        to: email,
        subject: 'Khôi phục mật khẩu - PreSFM',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 2rem auto; padding: 2rem; border: 1px solid #e5e7eb; border-radius: 12px;">
            <h2 style="text-align:center; color:#111827;">Đặt lại mật khẩu</h2>
            <p style="text-align:center; color:#4b5563;">
              Bạn đã yêu cầu đặt lại mật khẩu. Vui lòng bấm vào nút dưới đây để tạo mật khẩu mới. Link này sẽ hết hạn sau ${expiresMinutes} phút.
            </p>
            <div style="text-align:center; margin: 2rem 0;">
              <a href="${resetLink}" style="background:#1e40af; color:#ffffff; padding:12px 24px; text-decoration:none; border-radius:8px; font-weight:bold;">
                Đặt lại mật khẩu
              </a>
            </div>
            <p style="color:#9ca3af; font-size:12px; text-align:center;">
              Nếu nút bấm không hoạt động, bạn có thể copy link sau dán vào trình duyệt:<br>
              <a href="${resetLink}" style="color:#1e40af;">${resetLink}</a><br><br>
              Nếu bạn không yêu cầu đổi mật khẩu, vui lòng bỏ qua email này.
            </p>
          </div>
        `,
      });
      this.logger.log(`[SMTP] Gửi Reset Link thành công tới ${email}`);
    } catch (error) {
      this.logger.error(`[SMTP] Lỗi gửi Reset mail tới ${email}`, error);
      throw new InternalServerErrorException(
        'Không thể gửi email, vui lòng thử lại',
      );
    }
  }
}
