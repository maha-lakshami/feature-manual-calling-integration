import 'reflect-metadata';

import { HealthController } from './health.controller';
import { PUBLIC_KEY } from '../../common/decorators';

describe('HealthController', () => {
  const createResponse = () => ({ status: jest.fn() });

  it('exposes public, lightweight liveness with no secrets', () => {
    const controller = new HealthController({} as any, {} as any);

    expect(Reflect.getMetadata(PUBLIC_KEY, HealthController.prototype.liveness)).toBe('unauthenticated liveness probe');
    expect(controller.liveness()).toEqual(expect.objectContaining({ status: 'ok' }));
    expect(JSON.stringify(controller.liveness())).not.toMatch(/DATABASE_URL|REDIS_URL|JWT_SECRET|password|token/i);
  });

  it('reports healthy PostgreSQL and Redis dependencies', async () => {
    const controller = new HealthController(
      { ping: jest.fn().mockResolvedValue(true) } as any,
      { checkReadiness: jest.fn().mockResolvedValue(true), driverKind: 'bullmq' } as any,
    );
    const response = createResponse();

    await expect(controller.readiness(response as any)).resolves.toEqual({
      status: 'ok',
      database: 'connected',
      queue: 'ready',
    });
    expect(response.status).not.toHaveBeenCalled();
  });

  it('returns 503 when PostgreSQL is unavailable', async () => {
    const controller = new HealthController(
      { ping: jest.fn().mockResolvedValue(false) } as any,
      { checkReadiness: jest.fn().mockResolvedValue(true), driverKind: 'bullmq' } as any,
    );
    const response = createResponse();

    await expect(controller.readiness(response as any)).resolves.toEqual({
      status: 'degraded',
      database: 'disconnected',
      queue: 'ready',
    });
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('returns 503 when BullMQ Redis is unavailable', async () => {
    const controller = new HealthController(
      { ping: jest.fn().mockResolvedValue(true) } as any,
      { checkReadiness: jest.fn().mockResolvedValue(false), driverKind: 'bullmq' } as any,
    );
    const response = createResponse();

    await expect(controller.readiness(response as any)).resolves.toEqual({
      status: 'degraded',
      database: 'connected',
      queue: 'unavailable',
    });
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('does not require Redis for inline local readiness', async () => {
    const controller = new HealthController(
      { ping: jest.fn().mockResolvedValue(true) } as any,
      { checkReadiness: jest.fn().mockResolvedValue(true), driverKind: 'inline' } as any,
    );

    await expect(controller.readiness(createResponse() as any)).resolves.toEqual({
      status: 'ok',
      database: 'connected',
      queue: 'not-required',
    });
  });
});