import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { Public } from '../../common/auth/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EvolutionClient } from '../whatsapp/evolution.client';
import { OUTBOUND_QUEUE } from '../whatsapp/queues';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@ApiTags('Health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evolution: EvolutionClient,
    @InjectQueue(OUTBOUND_QUEUE) private readonly queue: Queue,
  ) {}

  /** Liveness: o processo está de pé (usado pelo healthcheck do Docker). */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependências críticas respondendo. */
  @Get()
  async ready() {
    const checks = {
      database: await this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redis: await this.queue.getJobCounts('waiting').then(() => true).catch(() => false),
      whatsappProvider: await this.evolution.ping(),
    };
    const ok = checks.database && checks.redis;
    const body = { status: ok ? (checks.whatsappProvider ? 'ok' : 'degraded') : 'down', checks };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }
}

@Module({
  imports: [WhatsappModule, BullModule.registerQueue({ name: OUTBOUND_QUEUE })],
  controllers: [HealthController],
})
export class HealthModule {}
