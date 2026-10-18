import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { DownloadQueueController } = await import('./download-queue.controller.js');
const { BadRequestException, NotFoundException } = await import('@nestjs/common');

describe('DownloadQueueController', () => {
	let controller: InstanceType<typeof DownloadQueueController>;
	const mockDownloadQueueService = {
		getOrCreateQueue: vi.fn(),
		getQueue: vi.fn(),
		getQueueById: vi.fn(),
		addItems: vi.fn(),
		getQueueItems: vi.fn(),
		getQueueItem: vi.fn(),
		deleteItem: vi.fn(),
		restartItem: vi.fn(),
		getItemById: vi.fn(),
		resolveItemStream: vi.fn(),
	};
	const mockMetadataService = {
		getItem: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		controller = new DownloadQueueController(mockDownloadQueueService as any, mockMetadataService as any);
	});

	describe('createOrGetQueue', () => {
		it('throws BadRequestException if client identifier is missing', async () => {
			await expect(controller.createOrGetQueue('', '', null)).rejects.toThrow(BadRequestException);
		});

		it('returns MediaContainer with DownloadQueue', async () => {
			mockDownloadQueueService.getOrCreateQueue.mockResolvedValue({ id: 1, status: 'done', itemCount: 0 });
			const result = await controller.createOrGetQueue('client-id', '', { id: 123 });
			expect(result.MediaContainer.DownloadQueue).toEqual([{ id: 1, status: 'done', itemCount: 0 }]);
		});
	});

	describe('getDecision', () => {
		it('returns Direct Play decision with directPlayDecisionCode 1000', async () => {
			mockDownloadQueueService.getItemById.mockResolvedValue({
				id: 2,
				queue_id: 1,
				key: '/library/metadata/abc',
				status: 'available',
				stream_url: 'https://cdn.example.com/stream.mkv',
			});
			mockMetadataService.getItem.mockResolvedValue({
				ratingKey: 'abc',
				title: 'Test Movie',
				type: 'movie',
			});

			const result = await controller.getDecision('1', '2');
			expect(result.MediaContainer.directPlayDecisionCode).toBe(1000);
			expect(result.MediaContainer.generalDecisionCode).toBe(1000);
			expect(result.MediaContainer.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.decision).toBe('directplay');
			expect(result.MediaContainer.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.key).toBe('/downloadQueue/1/item/2/media');
		});

		it('throws NotFoundException if item does not exist', async () => {
			mockDownloadQueueService.getItemById.mockResolvedValue(null);
			await expect(controller.getDecision('1', '999')).rejects.toThrow(NotFoundException);
		});
	});

	describe('deleteQueueItem', () => {
		it('returns empty string when item deleted successfully', async () => {
			mockDownloadQueueService.deleteItem.mockResolvedValue(true);
			const res = await controller.deleteQueueItem('1', '2');
			expect(res).toBe('');
		});

		it('throws NotFoundException if item not deleted', async () => {
			mockDownloadQueueService.deleteItem.mockResolvedValue(false);
			await expect(controller.deleteQueueItem('1', '2')).rejects.toThrow(NotFoundException);
		});
	});
});
