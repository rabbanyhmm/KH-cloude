import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import * as crypto from 'crypto';

let cachedRuntimeSecret: string | null = null;

/**
 * Resolve the platform signing secret once per process, falling back to an
 * ephemeral cryptographically-random secret rather than any hardcoded string.
 */
export function getJwtSecret(): string {
  const envSecret = process.env.JWT_SECRET ?? '';
  if (envSecret && envSecret.length >= 32) {
    return envSecret;
  }
  if (!cachedRuntimeSecret) {
    cachedRuntimeSecret = crypto.randomBytes(32).toString('hex');
  }
  return cachedRuntimeSecret;
}

export interface TokenPayload {
  sub: string;
  type: 'access' | 'refresh';
}

@Injectable()
export class TokenService implements OnModuleInit {
  private readonly logger = new Logger(TokenService.name);
  private secret!: Uint8Array;

  onModuleInit() {
    const envRaw = process.env.JWT_SECRET ?? '';
    if (!envRaw || envRaw.length < 32) {
      this.logger.warn(
        '⚠️ WARNING: JWT_SECRET is missing or too short. Generating an ephemeral random secret for this session. ' +
          'All users will be logged out when the server restarts. Please set a strong 32+ char JWT_SECRET in .env.',
      );
    }
    this.secret = new TextEncoder().encode(getJwtSecret());
    this.logger.log('TokenService initialized — JWT_SECRET loaded.');
  }

  async signAccessToken(userId: string): Promise<string> {
    return new SignJWT({ type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(process.env.JWT_EXPIRES_IN || '7d')
      .sign(this.secret);
  }

  async signRefreshToken(userId: string): Promise<string> {
    return new SignJWT({ type: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.secret);
  }

  async verifyToken(token: string): Promise<TokenPayload> {
    const { payload } = await jwtVerify(token, this.secret);
    return {
      sub: payload.sub as string,
      type: payload['type'] as 'access' | 'refresh',
    };
  }
}
