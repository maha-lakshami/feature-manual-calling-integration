import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';
import type { Response } from 'express';

import { Public } from '../../common/decorators';
import { NotFoundException, UnauthorizedException } from '../../common/errors/app-exception';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { StorageMockProvider } from './storage.mock';

/** Serves only time-limited, HMAC-authenticated objects from the local mock adapter. */
@Controller('mock-storage')
export class MockStorageController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageMockProvider,
  ) {}

  @Get()
  @Public('the expiring HMAC query authenticates access to one mock object')
  async read(
    @Query('key') key: string | undefined,
    @Query('expires') expires: string | undefined,
    @Query('sig') signature: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (this.config.providers.storage !== ProviderMode.MOCK) {
      throw new NotFoundException('Mock storage object', key ?? '(missing)');
    }
    if (!key || !expires || !signature) {
      throw new UnauthorizedException('The signed object URL is incomplete');
    }

    let object;
    try {
      object = await this.storage.readSignedObject(key, expires, signature);
    } catch {
      throw new UnauthorizedException('The signed object URL is invalid or expired');
    }
    if (!object) throw new NotFoundException('Mock storage object', key);

    response.setHeader('Content-Type', object.contentType || 'application/octet-stream');
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(object.body);
  }
}
