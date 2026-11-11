import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Headers,
  Req,
  Inject,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { Redis } from 'ioredis';
import { NetworkService } from './network.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('api/admin/network')
export class NetworkAdminController {
  constructor(
    @Inject('DDOS_REDIS') private readonly redis: Redis,
    private readonly networkService: NetworkService,
    private readonly prisma: PrismaService,
  ) {}

  private async requireAdmin(
    req: any,
    token?: string,
    adminUserId?: string,
  ): Promise<void> {
    // 1. Admin API key header check (constant-time comparison)
    const expected = process.env.ADMIN_API_KEY;
    if (expected && token) {
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return;
      }
    }

    // 2. Authenticated session user check — never trust query adminUserId alone
    const authUserId: string | undefined = req?.user?.id;
    if (!authUserId) {
      throw new UnauthorizedException('Authentication required.');
    }
    if (adminUserId && adminUserId !== authUserId) {
      throw new UnauthorizedException('Admin identity mismatch.');
    }

    const user = await (this.prisma as any).user.findUnique({
      where: { id: authUserId },
    });
    if (user && user.role === 'ADMIN') {
      return;
    }

    throw new UnauthorizedException('Invalid or missing admin credentials');
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/network/stats — Get 7-day traffic stats & top IPs
  // -------------------------------------------------------------------------
  @Get('stats')
  async getStats(
    @Req() req: any,
    @Headers('x-admin-key') token?: string,
    @Query('adminUserId') adminUserId?: string,
  ) {
    await this.requireAdmin(req, token, adminUserId);
    return this.networkService.getStats();
  }

  // -------------------------------------------------------------------------
  // POST /api/admin/network/clean — Trigger 7-day retention cleanup
  // -------------------------------------------------------------------------
  @Post('clean')
  async cleanOldLogs(
    @Req() req: any,
    @Headers('x-admin-key') token?: string,
    @Query('adminUserId') adminUserId?: string,
  ) {
    await this.requireAdmin(req, token, adminUserId);
    const result = await this.networkService.deleteOldLogs();
    return {
      message: `Successfully purged ${result.deletedCount} log records older than 7 days.`,
      deletedCount: result.deletedCount,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/admin/network/ban/:ip — Ban IP
  // -------------------------------------------------------------------------
  @Post('ban/:ip')
  async banIp(
    @Req() req: any,
    @Param('ip') ip: string,
    @Headers('x-admin-key') token?: string,
    @Query('adminUserId') adminUserId?: string,
  ) {
    await this.requireAdmin(req, token, adminUserId);
    const banTtl = parseInt(process.env.DDOS_BAN_TTL_SECONDS ?? '3600');
    await this.redis.set(`ddos:ban:${ip}`, 'manual', 'EX', banTtl);
    return {
      message: `IP ${ip} manually banned for ${banTtl / 60} minutes.`,
      ip,
      expiresInSeconds: banTtl,
    };
  }

  // -------------------------------------------------------------------------
  // DELETE /api/admin/network/ban/:ip — Unban IP
  // -------------------------------------------------------------------------
  @Delete('ban/:ip')
  async unbanIp(
    @Req() req: any,
    @Param('ip') ip: string,
    @Headers('x-admin-key') token?: string,
    @Query('adminUserId') adminUserId?: string,
  ) {
    await this.requireAdmin(req, token, adminUserId);
    const deleted = await this.redis.del(`ddos:ban:${ip}`);
    if (!deleted) {
      throw new NotFoundException(`IP ${ip} is not currently banned.`);
    }
    await this.redis.del(`ddos:viol:${ip}`);
    return { message: `IP ${ip} unbanned successfully.`, ip };
  }
}
