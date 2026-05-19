import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';

type TokenPayload = {
  sub: string;
  email: string;
  role: string;
  exp: number;
};

@Injectable()
export class TokenService {
  constructor(private readonly configService: ConfigService) {}

  createAccessToken(input: { userId: string; email: string; role: string }) {
    const expiresInSeconds = Number(this.configService.get<string>('JWT_ACCESS_EXPIRES_SECONDS', '900'));
    const payload: TokenPayload = {
      sub: input.userId,
      email: input.email,
      role: input.role,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    };
    return this.sign(payload);
  }

  createRefreshToken() {
    return randomBytes(48).toString('base64url');
  }

  hashRefreshToken(token: string) {
    return createHmac('sha256', this.secret()).update(token).digest('hex');
  }

  verifyAccessToken(token: string): TokenPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Invalid token');
    }
    const [encodedHeader, encodedPayload, signature] = parts;
    const expected = this.signature(`${encodedHeader}.${encodedPayload}`);
    if (signature !== expected) {
      throw new UnauthorizedException('Invalid token signature');
    }
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TokenPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Token expired');
    }
    return payload;
  }

  private sign(payload: TokenPayload) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.signature(`${header}.${body}`);
    return `${header}.${body}.${signature}`;
  }

  private signature(data: string) {
    return createHmac('sha256', this.secret()).update(data).digest('base64url');
  }

  private secret() {
    return this.configService.get<string>('JWT_ACCESS_SECRET', 'replace_with_secure_access_secret');
  }
}
