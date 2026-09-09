import { Injectable, type OnModuleInit } from '@nestjs/common';

import { QueueService } from '../queue/queue.service';
import { ContactImportService } from './contact-import.service';

@Injectable()
export class ContactImportProcessor implements OnModuleInit {
  constructor(private readonly queue: QueueService, private readonly imports: ContactImportService) {}

  onModuleInit(): void {
    this.queue.register('contact-import', (payload, context) => this.imports.process(payload, context));
  }
}
