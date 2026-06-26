import {
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
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
  // Cập nhật và bổ sung vào AuthController

  @Post('change-password')
  async changePassword(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      oldPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    },
  ) {
    const token = this.authService['extractBearerToken'](authorization);
    const payload = this.authService['tokenService'].verifyAccessToken(token);
    const userId = payload.sub;

    return this.authService.changePassword(userId, body);
  }

  @Post('forgot-password')
  forgotPassword(@Body() body: { email?: string; locale?: string }) {
    return this.authService.forgotPassword(body);
  }

  @Post('reset-password')
  resetPassword(
    @Body()
    body: {
      token?: string;
      newPassword?: string;
    },
  ) {
    return this.authService.resetPassword(body);
  }
  @Patch('profile')
  updateProfile(
    @Headers('authorization') authorization: string | undefined,
    @Body()
    body: {
      fullName?: string;
    },
  ) {
    const userId = this.authService.getUserIdFromAuthorization(authorization);

    return this.authService.updateProfile(userId, body);
  }
}
