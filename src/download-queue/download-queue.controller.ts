import {
	BadRequestException,
	Controller,
	Delete,
	Get,
	Headers,
	HttpCode,
	NotFoundException,
	Param,
	Post,
	Query,
	Req,
	Res,
	UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { ofetch } from 'ofetch';
import { LoggedInGuard } from '../middleware/logged-in.guard.js';
import { User } from '../utils/user.decorator.js';
import { DownloadQueueService } from './download-queue.service.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { parseKey } from '../utils/generic.js';
import { MediaContainer } from '../dto/MediaContainer.entity.js';
import { Metadata } from '../dto/Metadata.entity.js';

@Controller('downloadQueue')
@UseGuards(LoggedInGuard)
export class DownloadQueueController {
	constructor(
		private readonly downloadQueueService: DownloadQueueService,
		private readonly metadataService: MetadataService,
	) {}

	@Post()
	async createOrGetQueue(
		@Headers('x-plex-client-identifier') clientIdentifierHeader: string,
		@Query('X-Plex-Client-Identifier') clientIdentifierQuery: string,
		@User() user: any,
	) {
		const clientIdentifier = clientIdentifierHeader || clientIdentifierQuery;
		if (!clientIdentifier) {
			throw new BadRequestException('X-Plex-Client-Identifier is required');
		}

		const queue = await this.downloadQueueService.getOrCreateQueue(clientIdentifier, user?.id ?? null);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				DownloadQueue: [queue],
			} as any),
		};
	}

	@Get(':queueId')
	async getQueue(@Param('queueId') queueIdStr: string) {
		const queueId = Number.parseInt(queueIdStr, 10);
		if (Number.isNaN(queueId)) throw new BadRequestException('Invalid queueId');

		const queue = await this.downloadQueueService.getQueue(queueId);
		if (!queue) throw new NotFoundException('Download queue not found');

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				DownloadQueue: [queue],
			} as any),
		};
	}

	@Post(':queueId/add')
	async addToQueue(
		@Param('queueId') queueIdStr: string,
		@Query('keys') rawKeys: string | string[],
		@Query('videoResolution') videoResolution?: string,
	) {
		const queueId = Number.parseInt(queueIdStr, 10);
		if (Number.isNaN(queueId)) throw new BadRequestException('Invalid queueId');

		const queue = await this.downloadQueueService.getQueueById(queueId);
		if (!queue) throw new NotFoundException('Download queue not found');

		const keys = Array.isArray(rawKeys)
			? rawKeys
			: typeof rawKeys === 'string'
				? rawKeys.includes(',')
					? rawKeys.split(',')
					: [rawKeys]
				: [];

		if (keys.length === 0) {
			throw new BadRequestException('keys query parameter is required');
		}

		const added = await this.downloadQueueService.addItems(queueId, keys, videoResolution);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				AddedQueueItems: added,
			} as any),
		};
	}

	@Get(':queueId/items')
	async getQueueItems(@Param('queueId') queueIdStr: string) {
		const queueId = Number.parseInt(queueIdStr, 10);
		if (Number.isNaN(queueId)) throw new BadRequestException('Invalid queueId');

		const queue = await this.downloadQueueService.getQueueById(queueId);
		if (!queue) throw new NotFoundException('Download queue not found');

		const items = await this.downloadQueueService.getQueueItems(queueId);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				DownloadQueueItem: items,
			} as any),
		};
	}

	@Get(':queueId/items/:itemId')
	async getQueueItem(
		@Param('queueId') queueIdStr: string,
		@Param('itemId') itemIdStr: string,
	) {
		const queueId = Number.parseInt(queueIdStr, 10);
		const itemId = Number.parseInt(itemIdStr, 10);
		if (Number.isNaN(queueId) || Number.isNaN(itemId)) throw new BadRequestException('Invalid queueId or itemId');

		const item = await this.downloadQueueService.getQueueItem(queueId, itemId);
		if (!item) throw new NotFoundException('Download queue item not found');

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				DownloadQueueItem: [item],
			} as any),
		};
	}

	@Delete(':queueId/items/:itemId')
	@HttpCode(200)
	async deleteQueueItem(
		@Param('queueId') queueIdStr: string,
		@Param('itemId') itemIdStr: string,
	) {
		const queueId = Number.parseInt(queueIdStr, 10);
		const itemId = Number.parseInt(itemIdStr, 10);
		if (Number.isNaN(queueId) || Number.isNaN(itemId)) throw new BadRequestException('Invalid queueId or itemId');

		const deleted = await this.downloadQueueService.deleteItem(queueId, itemId);
		if (!deleted) throw new NotFoundException('Download queue item not found');

		return '';
	}

	@Post(':queueId/items/:itemId/restart')
	@HttpCode(200)
	async restartQueueItem(
		@Param('queueId') queueIdStr: string,
		@Param('itemId') itemIdStr: string,
	) {
		const queueId = Number.parseInt(queueIdStr, 10);
		if (Number.isNaN(queueId)) throw new BadRequestException('Invalid queueId');

		const itemIds = itemIdStr.includes(',')
			? itemIdStr.split(',').map((id) => Number.parseInt(id, 10)).filter((id) => !Number.isNaN(id))
			: [Number.parseInt(itemIdStr, 10)].filter((id) => !Number.isNaN(id));

		if (itemIds.length === 0) throw new BadRequestException('Invalid itemId');

		await this.downloadQueueService.restartItem(queueId, itemIds);
		return '';
	}

	@Get(':queueId/item/:itemId/decision')
	async getDecision(
		@Param('queueId') queueIdStr: string,
		@Param('itemId') itemIdStr: string,
	) {
		const queueId = Number.parseInt(queueIdStr, 10);
		const itemId = Number.parseInt(itemIdStr, 10);
		if (Number.isNaN(queueId) || Number.isNaN(itemId)) throw new BadRequestException('Invalid queueId or itemId');

		const item = await this.downloadQueueService.getItemById(itemId);
		if (!item || item.queue_id !== queueId) {
			throw new NotFoundException('Download queue item not found');
		}

		if (item.status === 'deciding') {
			// Await stream resolution if in progress
			await this.downloadQueueService.resolveItemStream(itemId);
		}

		const updatedItem = await this.downloadQueueService.getItemById(itemId);
		if (!updatedItem || updatedItem.status === 'error' || !updatedItem.stream_url) {
			throw new BadRequestException(updatedItem?.error_message ?? 'Item decision is not available');
		}

		const parsed = parseKey(item.key);
		const metadata = await this.metadataService.getItem(parsed.itemId ?? item.key);
		if (!metadata) {
			throw new NotFoundException('Metadata not found');
		}

		const directPart = {
			id: 1,
			key: `/downloadQueue/${queueId}/item/${itemId}/media`,
			decision: 'directplay',
			selected: true,
			container: 'mkv',
			exists: true,
			accessible: true,
			Stream: [],
		};

		const directMedia = {
			id: 1,
			selected: true,
			container: 'mkv',
			videoCodec: 'h264',
			audioCodec: 'aac',
			Part: [directPart],
		};

		const responseMetadata = new Metadata({
			...metadata,
			allowSync: true,
			Media: [directMedia as any],
		} as any);

		return {
			MediaContainer: new MediaContainer({
				allowSync: true,
				identifier: 'com.plexapp.plugins.library',
				directPlayDecisionCode: 1000,
				directPlayDecisionText: 'Direct play OK.',
				generalDecisionCode: 1000,
				generalDecisionText: 'Direct play OK.',
				transcodeDecisionCode: 1000,
				transcodeDecisionText: 'Direct play OK.',
				Metadata: [responseMetadata],
			} as any),
		};
	}

	@Get(':queueId/item/:itemId/media')
	async streamMedia(
		@Param('queueId') queueIdStr: string,
		@Param('itemId') itemIdStr: string,
		@Req() req: Request,
		@Res() res: Response,
	) {
		const queueId = Number.parseInt(queueIdStr, 10);
		const itemId = Number.parseInt(itemIdStr, 10);
		if (Number.isNaN(queueId) || Number.isNaN(itemId)) throw new BadRequestException('Invalid queueId or itemId');

		const item = await this.downloadQueueService.getItemById(itemId);
		if (!item || item.queue_id !== queueId) {
			throw new NotFoundException('Download queue item not found');
		}

		if (!item.stream_url) {
			throw new NotFoundException('Media stream not resolved');
		}

		const rangeHeader = req.headers.range;
		const ifRangeHeader = req.headers['if-range'];

		try {
			const upstreamHeaders: Record<string, string> = {};
			if (rangeHeader) upstreamHeaders['range'] = rangeHeader;
			if (ifRangeHeader && typeof ifRangeHeader === 'string') upstreamHeaders['if-range'] = ifRangeHeader;

			const response = await ofetch.raw(item.stream_url, {
				headers: upstreamHeaders,
				responseType: 'stream',
			});

			res.status(response.status);

			const contentRange = response.headers.get('content-range');
			if (contentRange) res.header('Content-Range', contentRange);

			res.header('Accept-Ranges', 'bytes');

			const contentType = response.headers.get('content-type');
			if (contentType) res.header('Content-Type', contentType);

			const contentLength = response.headers.get('content-length');
			if (contentLength) res.header('Content-Length', contentLength);

			const contentDisposition = response.headers.get('content-disposition');
			if (contentDisposition) res.header('Content-Disposition', contentDisposition);

			const nodeStream = Readable.fromWeb(response._data as any);
			req.on('close', () => nodeStream.destroy());
			nodeStream.pipe(res);
		} catch (error: any) {
			if (!res.headersSent) {
				res.status(502).json({ error: 'Upstream stream request failed', details: error?.message });
			}
		}
	}
}
