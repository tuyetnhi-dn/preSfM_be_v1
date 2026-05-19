import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('health')
  health() {
    return { service: 'auth-service', status: 'ok' };
  }

  @Post('register')
  register(
    @Body() body: { email?: string; password?: string; fullName?: string },
  ) {
    return this.authService.register(body);
  }

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

  @Post('refresh')
  refresh(@Body() body: { refreshToken?: string }) {
    return this.authService.refresh(body.refreshToken);
  }

  @Post('logout')
  logout(@Body() body: { refreshToken?: string }) {
    return this.authService.logout(body.refreshToken);
  }

  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    return this.authService.me(authorization);
  }
}
