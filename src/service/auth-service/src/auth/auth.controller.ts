import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Health ───────────────────────────────────────────────────────────────

  @Get('health')
  health() {
    return { service: 'auth-service', status: 'ok' };
  }

  // ─── OTP ──────────────────────────────────────────────────────────────────

  /** Gửi OTP 6 số về email — dùng trước khi đăng ký */
  @Post('send-otp')
  sendOtp(@Body() body: { email?: string }) {
    return this.authService.sendOtp(body);
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /** Đăng ký tài khoản — cần OTP hợp lệ */
  @Post('register')
  register(
    @Body()
    body: {
      email?: string;
      password?: string;
      otp?: string;
      fullName?: string;
    },
  ) {
    return this.authService.register(body);
  }

  /** Đăng nhập — trả về accessToken + refreshToken */
  @Post('login')
  login(
    @Body() body: { email?: string; password?: string },
    @Req() request: Request,
  ) {
    return this.authService.login({
      ...body,
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });
  }

  /** Làm mới accessToken bằng refreshToken */
  @Post('refresh')
  refresh(@Body() body: { refreshToken?: string }) {
    return this.authService.refresh(body.refreshToken);
  }

  /** Đăng xuất — thu hồi session */
  @Post('logout')
  logout(@Body() body: { refreshToken?: string }) {
    return this.authService.logout(body.refreshToken);
  }

  /** Lấy thông tin user hiện tại từ accessToken */
  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    return this.authService.me(authorization);
  }
}
