import type { ColumnType } from 'kysely';

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

export interface ItemMappings {
	guid: string;
	item_id: string;
	url: string;
}

export interface PlayQueues {
	id: Generated<number>;
	playbackSessionId: string;
	currentItem: string; //GUID of the currently playing item
	item: string; //Show or movie Plex GUID (plex://show/<id> | plex://movie/<id>)
	offset: number; //Internal, client-invisible offset into the episode list
	updated_at: Generated<number | null>;
	created_at: Generated<number | null>;
}

export interface DB_Metadata {
	created_at: Generated<number | null>;
	data: unknown;
	id: string;
	imdb_id: Generated<string | null>;
	tmdb_id: Generated<string | null>;
	tvdb_id: Generated<string | null>;
	type: Generated<string>;
	updated_at: Generated<number | null>;
}

export interface Progress {
	id: Generated<number>;
	account_id: number | null;
	guid: string; //Plex GUID
	parent_guid: string; //Plex GUID
	grandparent_guid: string | null; //Plex GUID
	index: number | null;
	parent_index: number | null;
	view_count: number | null;
	view_offset: number | null;
	last_viewed_at: number | null;
	updated_at: Generated<number | null>;
	created_at: Generated<number | null>;
}

export interface ScrobbleSync {
	account_id: number;
	cursor: string | null; //Page key (endCursor) to resume from on the next state sync
	viewed_at: number;
	updated_at: Generated<number | null>;
}

export interface DownloadQueues {
	id: Generated<number>;
	client_identifier: string; // X-Plex-Client-Identifier
	account_id: number | null; // Plex User ID
	status: 'deciding' | 'waiting' | 'processing' | 'done' | 'error';
	created_at: Generated<number | null>;
	updated_at: Generated<number | null>;
}

export interface DownloadQueueItems {
	id: Generated<number>;
	queue_id: number;
	key: string;               // e.g. /library/metadata/628b0... or flex:episode:...
	guid: string;              // Normalized Plex Discover / Stremio GUID
	status: 'deciding' | 'waiting' | 'processing' | 'available' | 'done' | 'error';
	target_quality: string | null; // e.g. 1080p, 720p, original
	stream_url: string | null; // Resolved Debrid stream URL
	error_message: string | null;
	created_at: Generated<number | null>;
	updated_at: Generated<number | null>;
}

export interface DB {
	item_mappings: ItemMappings;
	play_queues: PlayQueues;
	progress: Progress;
	metadata: DB_Metadata;
	scrobble_sync: ScrobbleSync;
	download_queues: DownloadQueues;
	download_queue_items: DownloadQueueItems;
}

