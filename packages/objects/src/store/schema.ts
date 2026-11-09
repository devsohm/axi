import {
	applySqliteMigrations,
	type SqliteDatabase,
	type SqliteMigration,
} from "../sqlite/index.ts";

export const TABLES = {
	meta: "objects_meta",
	tables: "objects_tables",
	documents: "objects_documents",
	revisions: "objects_revisions",
	outbox: "objects_outbox",
} as const;
export type MetaRow = {
	readonly last_seq: number;
	readonly next_id: number;
	readonly outbox: number;
	readonly outbox_floor: number;
};
const migrations: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE ${TABLES.meta} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), last_seq INTEGER NOT NULL,
		 next_id INTEGER NOT NULL, outbox INTEGER NOT NULL CHECK(outbox IN (0, 1)), outbox_floor INTEGER NOT NULL) STRICT`,
			`INSERT INTO ${TABLES.meta} VALUES (1, 0, 2, 0, 0)`,
			`CREATE TABLE ${TABLES.tables} (name TEXT PRIMARY KEY, definition TEXT NOT NULL) STRICT, WITHOUT ROWID`,
			`CREATE TABLE ${TABLES.documents} (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, namespace TEXT NOT NULL,
		 kind TEXT NOT NULL, key TEXT NOT NULL, history TEXT NOT NULL CHECK(history IN ('none', 'latest', 'rewindable')),
		 created_at INTEGER NOT NULL, retired_at INTEGER, meta TEXT, revision INTEGER NOT NULL, version INTEGER NOT NULL,
		 fingerprint TEXT NOT NULL) STRICT`,
			`CREATE UNIQUE INDEX objects_documents_live ON ${TABLES.documents} (owner, namespace, kind, key) WHERE retired_at IS NULL`,
			`CREATE TABLE ${TABLES.revisions} (document_id INTEGER NOT NULL, seq INTEGER NOT NULL,
		 kind TEXT NOT NULL CHECK(kind IN ('base', 'delta')), version INTEGER NOT NULL, content TEXT NOT NULL,
		 PRIMARY KEY(document_id, seq)) STRICT, WITHOUT ROWID`,
			`CREATE TABLE ${TABLES.outbox} (seq INTEGER PRIMARY KEY, format INTEGER NOT NULL, next_id INTEGER NOT NULL, writes TEXT NOT NULL) STRICT`,
		],
	},
	{
		version: 2,
		statements: [
			`CREATE INDEX objects_documents_address ON ${TABLES.documents} (owner, namespace, kind, key, created_at)`,
			`CREATE INDEX objects_documents_scope ON ${TABLES.documents} (owner, namespace, id)`,
			`CREATE INDEX objects_revisions_bases ON ${TABLES.revisions} (document_id, seq) WHERE kind = 'base'`,
		],
	},
];
export const STORE_SCHEMA = 2;
const currentSql = `SELECT s.version, e.encoding, m.last_seq, m.next_id, m.outbox, m.outbox_floor
 FROM objects_store_schema s, pragma_encoding e, ${TABLES.meta} m WHERE s.singleton = 1 AND m.singleton = 1`;

export async function applyStoreSchema(db: SqliteDatabase): Promise<MetaRow> {
	let current: (MetaRow & { version: number; encoding: string }) | undefined;
	try {
		current = await db.get(currentSql);
	} catch {
		/* A new or older database takes the migration path. */
	}
	if (current?.version === STORE_SCHEMA && current.encoding === "UTF-8") {
		const { last_seq, next_id, outbox, outbox_floor } = current;
		return { last_seq, next_id, outbox, outbox_floor };
	}
	const encoding = await db.get<{ encoding: string }>("PRAGMA encoding");
	if (encoding?.encoding !== "UTF-8")
		throw new Error(
			`store: the database encoding is ${encoding?.encoding}, not UTF-8`,
		);
	await applySqliteMigrations(db, migrations, {
		table: "objects_store_schema",
	});
	const metadata = await db.get<MetaRow>(
		`SELECT last_seq, next_id, outbox, outbox_floor FROM ${TABLES.meta} WHERE singleton = 1`,
	);
	if (!metadata) throw new Error("store: the metadata row is missing");
	return metadata;
}
