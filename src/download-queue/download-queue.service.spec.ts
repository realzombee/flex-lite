import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { db } = await import('../utils/database.js');
const { DownloadQueueService } = await import('./download-queue.service.js');

describe('DownloadQueueService', () => {
	let service: InstanceType<typeof DownloadQueueService>;
	const mockMetadataService = {
		getItem: vi.fn(),
	};
	const mockStremioService = {
		resolveStream: vi.fn(),
	};

	beforeAll(async () => {
		await sql`CREATE TABLE IF NOT EXISTS download_queues (
			id integer primary key autoincrement,
			client_identifier text not null,
			account_id integer,
			status text not null default 'waiting',
			updated_at integer,
			created_at integer
		)`.execute(db);

		await sql`CREATE TABLE IF NOT EXISTS download_queue_items (
			id integer primary key autoincrement,
			queue_id integer not null,
			key text not null,
			guid text not null,
			status text not null default 'deciding',
			target_quality text,
			stream_url text,
			error_message text,
			updated_at integer,
			created_at integer
		)`.execute(db);

		await sql`CREATE TABLE IF NOT EXISTS item_mappings (
			guid text primary key,
			item_id text not null,
			url text not null,
			created_at integer
		)`.execute(db);
	});

	beforeEach(async () => {
		await sql`DELETE FROM download_queue_items`.execute(db);
		await sql`DELETE FROM download_queues`.execute(db);
		await sql`DELETE FROM item_mappings`.execute(db);
		vi.clearAllMocks();
		service = new DownloadQueueService(mockMetadataService as any, mockStremioService as any);
	});

	it('creates a new download queue for a client identifier and reuses it on subsequent calls', async () => {
		const q1 = await service.getOrCreateQueue('client-123', 1);
		expect(q1.id).toBeDefined();
		expect(q1.status).toBe('done'); // 0 items = done
		expect(q1.itemCount).toBe(0);

		const q2 = await service.getOrCreateQueue('client-123', 1);
		expect(q2.id).toBe(q1.id);
	});

	it('adds items to queue, deduplicates by key within the same queue, and calculates aggregate status', async () => {
		const q = await service.getOrCreateQueue('client-abc', null);

		mockMetadataService.getItem.mockResolvedValue({
			ratingKey: '68ec89c449b9526d4b7250a3',
			guid: 'plex://movie/68ec89c449b9526d4b7250a3',
			type: 'movie',
		});
		mockStremioService.resolveStream.mockResolvedValue({
			url: 'https://debrid.provider.com/stream/movie.mkv',
		});

		const added = await service.addItems(q.id, ['/library/metadata/68ec89c449b9526d4b7250a3']);
		expect(added).toHaveLength(1);
		expect(added[0].key).toBe('/library/metadata/68ec89c449b9526d4b7250a3');

		// Wait for microtask/async resolution
		await new Promise((r) => setTimeout(r, 50));

		const items = await service.getQueueItems(q.id);
		expect(items).toHaveLength(1);
		expect(items[0].status).toBe('available');
		expect(items[0].DecisionResult?.directPlayDecisionCode).toBe(1000);

		const updatedQ = await service.getQueue(q.id);
		expect(updatedQ?.status).toBe('done'); // all available = done
		expect(updatedQ?.itemCount).toBe(1);

		// Adding same key reuses item id
		const addedAgain = await service.addItems(q.id, ['/library/metadata/68ec89c449b9526d4b7250a3']);
		expect(addedAgain[0].id).toBe(added[0].id);
	});

	it('handles stream resolution error gracefully', async () => {
		const q = await service.getOrCreateQueue('client-error', null);

		mockMetadataService.getItem.mockResolvedValue({
			ratingKey: 'broken-key',
			guid: 'plex://movie/broken-key',
		});
		mockStremioService.resolveStream.mockResolvedValue(null);

		await service.addItems(q.id, ['/library/metadata/broken-key']);
		await new Promise((r) => setTimeout(r, 50));

		const items = await service.getQueueItems(q.id);
		expect(items).toHaveLength(1);
		expect(items[0].status).toBe('error');
		expect(items[0].error).toBeDefined();

		const updatedQ = await service.getQueue(q.id);
		expect(updatedQ?.status).toBe('error');
	});

	it('deletes items and updates aggregate status', async () => {
		const q = await service.getOrCreateQueue('client-del', null);
		mockMetadataService.getItem.mockResolvedValue({ ratingKey: 'k1', guid: 'plex://movie/k1' });
		mockStremioService.resolveStream.mockResolvedValue({ url: 'https://example.com/1.mkv' });

		const added = await service.addItems(q.id, ['/library/metadata/k1']);
		await new Promise((r) => setTimeout(r, 50));

		const deleted = await service.deleteItem(q.id, added[0].id);
		expect(deleted).toBe(true);

		const items = await service.getQueueItems(q.id);
		expect(items).toHaveLength(0);
	});

	it('restarts failed items', async () => {
		const q = await service.getOrCreateQueue('client-restart', null);
		mockMetadataService.getItem.mockResolvedValue({ ratingKey: 'k2', guid: 'plex://movie/k2' });
		mockStremioService.resolveStream.mockResolvedValueOnce(null);

		const added = await service.addItems(q.id, ['/library/metadata/k2']);
		await new Promise((r) => setTimeout(r, 50));

		let item = await service.getQueueItem(q.id, added[0].id);
		expect(item?.status).toBe('error');

		mockStremioService.resolveStream.mockResolvedValueOnce({ url: 'https://example.com/2.mkv' });
		await service.restartItem(q.id, [added[0].id]);
		await new Promise((r) => setTimeout(r, 50));

		item = await service.getQueueItem(q.id, added[0].id);
		expect(item?.status).toBe('available');
	});
});
