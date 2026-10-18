import { Injectable, Logger } from '@nestjs/common';
import { db } from '../utils/database.js';
import { probeUrl } from '../utils/probe-url.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { StremioService } from '../stremio/stremio.service.js';
import { parseKey } from '../utils/generic.js';
import {
	AddedQueueItemDto,
	DownloadQueueDto,
	DownloadQueueItemDto,
	QueueItemStatus,
	QueueStatus,
} from './download-queue.dto.js';
import { Metadata } from '../dto/Metadata.entity.js';

export type DownloadQueueRecord = {
	id: number;
	client_identifier: string;
	account_id: number | null;
	status: QueueStatus;
	created_at?: number | null;
	updated_at?: number | null;
};

export type DownloadQueueItemRecord = {
	id: number;
	queue_id: number;
	key: string;
	guid: string;
	status: QueueItemStatus;
	target_quality: string | null;
	stream_url: string | null;
	error_message: string | null;
	created_at?: number | null;
	updated_at?: number | null;
};

@Injectable()
export class DownloadQueueService {
	private readonly logger = new Logger(DownloadQueueService.name);

	//In-flight stream resolutions by item id, so a decision request does not trigger a second resolution while one is already running
	private readonly resolving = new Map<number, Promise<void>>();

	constructor(
		private readonly metadataService: MetadataService,
		private readonly stremioService: StremioService,
	) {}

	async getQueueById(queueId: number): Promise<DownloadQueueRecord | undefined> {
		const row = await db
			.selectFrom('download_queues')
			.selectAll()
			.where('id', '=', queueId)
			.executeTakeFirst();
		return row as DownloadQueueRecord | undefined;
	}

	async getItemById(itemId: number): Promise<DownloadQueueItemRecord | undefined> {
		const row = await db
			.selectFrom('download_queue_items')
			.selectAll()
			.where('id', '=', itemId)
			.executeTakeFirst();
		return row as DownloadQueueItemRecord | undefined;
	}

	async getOrCreateQueue(clientIdentifier: string, accountId: number | null): Promise<DownloadQueueDto> {
		let queue = await db
			.selectFrom('download_queues')
			.selectAll()
			.where('client_identifier', '=', clientIdentifier)
			.executeTakeFirst();

		if (!queue) {
			const now = Math.floor(Date.now() / 1000);
			const inserted = await db
				.insertInto('download_queues')
				.values({
					client_identifier: clientIdentifier,
					account_id: accountId,
					status: 'waiting',
					created_at: now,
					updated_at: now,
				})
				.returningAll()
				.executeTakeFirst();
			queue = inserted;
		}

		if (!queue) {
			throw new Error('Failed to create or retrieve download queue');
		}

		return await this.calculateQueueDto(queue as DownloadQueueRecord);
	}

	async getQueue(queueId: number): Promise<DownloadQueueDto | undefined> {
		const queue = await this.getQueueById(queueId);
		if (!queue) return undefined;
		return await this.calculateQueueDto(queue);
	}

	async addItems(
		queueId: number,
		keys: string[],
		targetQuality?: string,
	): Promise<AddedQueueItemDto[]> {
		const added: AddedQueueItemDto[] = [];
		const now = Math.floor(Date.now() / 1000);

		for (const key of keys) {
			const parsed = parseKey(key);
			const ratingKey = parsed.itemId ?? key;

			// Extract guid or normalize
			const metadataItem = await this.metadataService.getItem(ratingKey);
			const guid = metadataItem?.guid ?? `plex://metadata/${ratingKey}`;

			// Check if item already exists in this queue with the same key
			const existing = await db
				.selectFrom('download_queue_items')
				.selectAll()
				.where('queue_id', '=', queueId)
				.where('key', '=', key)
				.executeTakeFirst();

			if (existing) {
				added.push({ id: existing.id, key: existing.key });
				// Trigger background resolution if it's deciding
				if (existing.status === 'deciding' || !existing.stream_url) {
					void this.resolveItemStream(existing.id, metadataItem);
				}
			} else {
				const inserted = await db
					.insertInto('download_queue_items')
					.values({
						queue_id: queueId,
						key,
						guid,
						status: 'deciding',
						target_quality: targetQuality ?? null,
						stream_url: null,
						error_message: null,
						created_at: now,
						updated_at: now,
					})
					.returningAll()
					.executeTakeFirst();

				if (inserted) {
					added.push({ id: inserted.id, key: inserted.key });
					void this.resolveItemStream(inserted.id, metadataItem);
				}
			}
		}

		await this.updateQueueAggregateStatus(queueId);
		return added;
	}

	async getQueueItems(queueId: number): Promise<DownloadQueueItemDto[]> {
		const items = await db
			.selectFrom('download_queue_items')
			.selectAll()
			.where('queue_id', '=', queueId)
			.execute();

		return (items as DownloadQueueItemRecord[]).map((item) => this.toQueueItemDto(item));
	}

	async getQueueItem(queueId: number, itemId: number): Promise<DownloadQueueItemDto | undefined> {
		const item = await db
			.selectFrom('download_queue_items')
			.selectAll()
			.where('queue_id', '=', queueId)
			.where('id', '=', itemId)
			.executeTakeFirst();

		if (!item) return undefined;
		return this.toQueueItemDto(item as DownloadQueueItemRecord);
	}

	async deleteItem(queueId: number, itemId: number): Promise<boolean> {
		const result = await db
			.deleteFrom('download_queue_items')
			.where('queue_id', '=', queueId)
			.where('id', '=', itemId)
			.executeTakeFirst();

		await this.updateQueueAggregateStatus(queueId);
		return Number(result.numDeletedRows) > 0;
	}

	async restartItem(queueId: number, itemIds: number[]): Promise<void> {
		const now = Math.floor(Date.now() / 1000);
		for (const id of itemIds) {
			const item = await this.getItemById(id);
			if (!item || item.queue_id !== queueId) continue;

			await db
				.updateTable('download_queue_items')
				.set({
					status: 'deciding',
					stream_url: null,
					error_message: null,
					updated_at: now,
				})
				.where('id', '=', id)
				.execute();

			const parsed = parseKey(item.key);
			const metadataItem = await this.metadataService.getItem(parsed.itemId ?? item.key);
			void this.resolveItemStream(id, metadataItem);
		}

		await this.updateQueueAggregateStatus(queueId);
	}

	async resolveItemStream(itemId: number, metadataItem?: Metadata | null): Promise<void> {
		const inFlight = this.resolving.get(itemId);
		if (inFlight) return inFlight;

		const resolution = this.runResolution(itemId, metadataItem).finally(() => {
			this.resolving.delete(itemId);
		});
		this.resolving.set(itemId, resolution);
		return resolution;
	}

	private async runResolution(itemId: number, metadataItem?: Metadata | null): Promise<void> {
		try {
			const item = await this.getItemById(itemId);
			if (!item) return;

			let meta = metadataItem;
			if (!meta) {
				const parsed = parseKey(item.key);
				meta = await this.metadataService.getItem(parsed.itemId ?? item.key);
			}

			if (!meta) {
				await this.markItemError(itemId, `Metadata not found for ${item.key}`);
				return;
			}

			// Check active item_mappings first
			const guidClean = meta.guid?.split('/').pop();
			if (guidClean) {
				const mapping = await db
					.selectFrom('item_mappings')
					.select('url')
					.where('guid', '=', guidClean)
					.executeTakeFirst();

				if (mapping?.url) {
					const isWorking = await probeUrl(mapping.url);
					if (isWorking) {
						this.logger.debug(`Reusing active item mapping URL for download item ${itemId}`);
						await this.markItemAvailable(itemId, mapping.url);
						return;
					}
				}
			}

			// Resolve via StremioService
			const streamResult = await this.stremioService.resolveStream(meta);
			if (streamResult?.url && !streamResult.notFound) {
				await this.markItemAvailable(itemId, streamResult.url);
			} else {
				await this.markItemError(itemId, 'No working stream found');
			}
		} catch (error: any) {
			this.logger.error(`Error resolving stream for item ${itemId}: ${error?.message ?? error}`);
			await this.markItemError(itemId, error?.message ?? 'Failed to resolve stream');
		}
	}

	private async markItemAvailable(itemId: number, streamUrl: string): Promise<void> {
		const now = Math.floor(Date.now() / 1000);
		await db
			.updateTable('download_queue_items')
			.set({
				status: 'available',
				stream_url: streamUrl,
				error_message: null,
				updated_at: now,
			})
			.where('id', '=', itemId)
			.execute();

		const item = await this.getItemById(itemId);
		if (item) {
			await this.updateQueueAggregateStatus(item.queue_id);
		}
	}

	private async markItemError(itemId: number, errorMessage: string): Promise<void> {
		const now = Math.floor(Date.now() / 1000);
		await db
			.updateTable('download_queue_items')
			.set({
				status: 'error',
				error_message: errorMessage,
				updated_at: now,
			})
			.where('id', '=', itemId)
			.execute();

		const item = await this.getItemById(itemId);
		if (item) {
			await this.updateQueueAggregateStatus(item.queue_id);
		}
	}

	private async updateQueueAggregateStatus(queueId: number): Promise<void> {
		const items = await db
			.selectFrom('download_queue_items')
			.selectAll()
			.where('queue_id', '=', queueId)
			.execute();

		const status = this.computeAggregateStatus((items as DownloadQueueItemRecord[]).map((i) => i.status));
		const now = Math.floor(Date.now() / 1000);

		await db
			.updateTable('download_queues')
			.set({
				status,
				updated_at: now,
			})
			.where('id', '=', queueId)
			.execute();
	}

	private computeAggregateStatus(statuses: QueueItemStatus[]): QueueStatus {
		if (statuses.length === 0) return 'done';
		if (statuses.includes('error')) return 'error';
		if (statuses.includes('deciding')) return 'deciding';
		if (statuses.includes('processing')) return 'processing';
		if (statuses.includes('waiting')) return 'waiting';
		return 'done';
	}

	private async calculateQueueDto(queue: DownloadQueueRecord): Promise<DownloadQueueDto> {
		const items = await db
			.selectFrom('download_queue_items')
			.selectAll()
			.where('queue_id', '=', queue.id)
			.execute();

		const typedItems = items as DownloadQueueItemRecord[];
		const status = this.computeAggregateStatus(typedItems.map((i) => i.status));

		return {
			id: queue.id,
			status,
			itemCount: typedItems.length,
		};
	}

	private toQueueItemDto(item: DownloadQueueItemRecord): DownloadQueueItemDto {
		const dto: DownloadQueueItemDto = {
			id: item.id,
			queueId: item.queue_id,
			key: item.key,
			status: item.status,
		};

		if (item.error_message) {
			dto.error = item.error_message;
		}

		if (item.status === 'available' || item.status === 'done') {
			dto.DecisionResult = {
				generalDecisionCode: 1000,
				generalDecisionText: 'Direct play OK.',
				directPlayDecisionCode: 1000,
				directPlayDecisionText: 'Direct play OK.',
			};
		}

		return dto;
	}
}
