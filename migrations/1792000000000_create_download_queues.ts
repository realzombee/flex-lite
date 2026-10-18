import { sql, SqliteAdapter, type Kysely, type Transaction } from 'kysely';

async function transaction(db: any, dialect: string, cb: (trx: Transaction<any>) => void) {
	if (dialect === 'sqlite') await db.transaction().execute(cb);
	else await cb(db);
}

export async function up(db: Kysely<any>): Promise<void> {
	const dialect = db.getExecutor().adapter.constructor.name == 'SqliteAdapter' ? 'sqlite' : 'postgres';

	await transaction(db, dialect, async (trx) => {
		await trx.schema
			.createTable('download_queues')
			.addColumn('id', dialect === 'postgres' ? 'serial' : 'integer', (col) =>
				dialect === 'postgres' ? col.primaryKey() : col.autoIncrement().primaryKey(),
			)
			.addColumn('client_identifier', 'text', (col) => col.notNull())
			.addColumn('account_id', 'integer')
			.addColumn('status', 'text', (col) => col.notNull().defaultTo('waiting'))
			.addColumn('updated_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.addColumn('created_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.execute();

		await trx.schema
			.createIndex('download_queues_idx')
			.on('download_queues')
			.columns(['id', 'client_identifier', 'account_id', 'status'])
			.execute();

		await trx.schema
			.createTable('download_queue_items')
			.addColumn('id', dialect === 'postgres' ? 'serial' : 'integer', (col) =>
				dialect === 'postgres' ? col.primaryKey() : col.autoIncrement().primaryKey(),
			)
			.addColumn('queue_id', 'integer', (col) => col.notNull())
			.addColumn('key', 'text', (col) => col.notNull())
			.addColumn('guid', 'text', (col) => col.notNull())
			.addColumn('status', 'text', (col) => col.notNull().defaultTo('deciding'))
			.addColumn('target_quality', 'text')
			.addColumn('stream_url', 'text')
			.addColumn('error_message', 'text')
			.addColumn('updated_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.addColumn('created_at', 'integer', (col) =>
				dialect === 'postgres' ? col.defaultTo(sql`EXTRACT(EPOCH FROM now())::integer`) : col.defaultTo(sql`(strftime('%s', 'now'))`),
			)
			.execute();

		await trx.schema
			.createIndex('download_queue_items_idx')
			.on('download_queue_items')
			.columns(['id', 'queue_id', 'status'])
			.execute();
	});
}

export async function down(db: Kysely<any>): Promise<void> {
	const dialect = db.getExecutor().adapter instanceof SqliteAdapter ? 'sqlite' : 'postgres';

	await transaction(db, dialect, async (trx) => {
		await trx.schema.dropIndex('download_queue_items_idx').ifExists().execute();
		await trx.schema.dropTable('download_queue_items').ifExists().execute();
		await trx.schema.dropIndex('download_queues_idx').ifExists().execute();
		await trx.schema.dropTable('download_queues').ifExists().execute();
	});
}
