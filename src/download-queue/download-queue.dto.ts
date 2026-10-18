export type QueueStatus = 'deciding' | 'waiting' | 'processing' | 'done' | 'error';
export type QueueItemStatus = 'deciding' | 'waiting' | 'processing' | 'available' | 'done' | 'error' | 'expired';

export interface DecisionResultDto {
	generalDecisionCode: number;
	generalDecisionText: string;
	directPlayDecisionCode: number;
	directPlayDecisionText: string;
	transcodeDecisionCode?: number;
	transcodeDecisionText?: string;
	mdeDecisionCode?: number;
	mdeDecisionText?: string;
	availableBandwidth?: number;
}

export interface DownloadQueueItemDto {
	id: number;
	queueId: number;
	key: string;
	status: QueueItemStatus;
	DecisionResult?: DecisionResultDto;
	error?: string;
}

export interface DownloadQueueDto {
	id: number;
	status: QueueStatus;
	itemCount: number;
}

export interface AddedQueueItemDto {
	id: number;
	key: string;
}
