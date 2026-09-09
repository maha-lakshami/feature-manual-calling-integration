import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../../common/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  @Public('unauthenticated liveness probe')
  @ApiOperation({ summary: 'Liveness probe' })
  liveness(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @Public('unauthenticated readiness probe')
  @ApiOperation({ summary: 'Readiness probe' })
  async readiness(@Res({ passthrough: true }) res: Response): Promise<{
    status: 'ok' | 'degraded';
    database: 'connected' | 'disconnected';
    queue: 'ready' | 'unavailable' | 'not-required';
  }> {
    const [dbOk, queueOk] = await Promise.all([this.prisma.ping(), this.queue.checkReadiness()]);
    if (!dbOk || !queueOk) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'degraded',
        database: dbOk ? 'connected' : 'disconnected',
        queue: this.queue.driverKind === 'inline' ? 'not-required' : queueOk ? 'ready' : 'unavailable',
      };
    }
    return {
      status: 'ok',
      database: 'connected',
      queue: this.queue.driverKind === 'inline' ? 'not-required' : 'ready',
    };
  }
}
