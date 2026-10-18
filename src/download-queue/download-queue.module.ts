import { Module } from '@nestjs/common';
import { DownloadQueueController } from './download-queue.controller.js';
import { DownloadQueueService } from './download-queue.service.js';
import { MetadataModule } from '../metadata/metadata.module.js';
import { StremioModule } from '../stremio/stremio.module.js';

@Module({
	imports: [MetadataModule, StremioModule],
	controllers: [DownloadQueueController],
	providers: [DownloadQueueService],
	exports: [DownloadQueueService],
})
export class DownloadQueueModule {}
