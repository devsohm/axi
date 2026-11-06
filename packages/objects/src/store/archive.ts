import { objectsMetrics } from "../telemetry.ts";
import Type from "typebox";
import type { Context } from "../context/index.ts";
import {
	arr,
	bool,
	int,
	lit,
	num,
	obj,
	opt,
	str,
	union,
	unknown,
} from "../contracts/index.ts";
import { invalid, validatorFor } from "../data/internal.ts";
import type { DocumentWrite } from "./engine.ts";
import type { TableWrite } from "./table-writes.ts";
import type { StoreWrite } from "./writes.ts";

export const ARCHIVE_FORMAT = 1;
export type ArchiveManifest = {
	readonly kind: "manifest";
	readonly format: number;
	readonly schema: number;
	readonly lastSeq: number;
	readonly nextId: number;
};
export type ArchivePart =
	| ArchiveManifest
	| Extract<TableWrite, { readonly kind: "table" | "put" | "index" }>
	| Extract<
			DocumentWrite,
			{ readonly kind: "document.create" | "document.revision" }
	  >
	| { readonly kind: "end"; readonly writes: number };

const count = int({ min: 0, max: Number.MAX_SAFE_INTEGER }),
	positive = int({ min: 1, max: Number.MAX_SAFE_INTEGER });
const column = obj({
	type: union([lit("str"), lit("int"), lit("num"), lit("bool"), lit("json")]),
	optional: opt(lit(true)),
	default: opt(union([str(), num(), bool()])),
	version: opt(positive),
	fingerprint: opt(str()),
});
const columns = Type.Record(Type.String(), column);
const versions = Type.Record(Type.String(), positive),
	cells = Type.Record(Type.String(), unknown());
const table = obj({
	kind: lit("table"),
	table: str(),
	version: positive,
	state: union([lit("ready"), lit("migrating")]),
	columns,
	key: arr(str()),
	fingerprint: str(),
});
const put = obj({
	kind: lit("put"),
	table: str(),
	row: cells,
	version: positive,
	columns: versions,
});
const index = obj({
	kind: lit("index"),
	table: str(),
	name: str(),
	columns: arr(str()),
});
const record = obj({
	id: positive,
	owner: str(),
	namespace: str(),
	kind: str(),
	key: opt(str()),
	history: union([lit("none"), lit("latest"), lit("rewindable")]),
	createdAt: positive,
	retiredAt: opt(positive),
	meta: opt(str()),
	revision: positive,
	version: positive,
	fingerprint: str(),
});
const base = obj({ version: positive, fingerprint: str(), value: unknown() });
const delta = obj({
	kind: lit("delta"),
	version: positive,
	ops: arr(unknown()),
});
const partSchema = {
	schema: union([
		obj({
			kind: lit("manifest"),
			format: positive,
			schema: positive,
			lastSeq: count,
			nextId: positive,
		}),
		table,
		put,
		index,
		obj({ kind: lit("document.create"), record }),
		obj({
			kind: lit("document.revision"),
			id: positive,
			seq: positive,
			content: union([
				obj({ kind: lit("base"), version: positive, value: unknown() }),
				delta,
			]),
		}),
		obj({ kind: lit("end"), writes: count }),
	]),
};
const alter = union([
	obj({ kind: lit("rename"), from: str(), to: str() }),
	obj({ kind: lit("add"), name: str(), column }),
	obj({ kind: lit("drop"), name: str() }),
	obj({ kind: lit("json"), name: str(), column }),
]);
const key = Type.Record(Type.String(), union([str(), num(), bool()]));
const writeSchema = {
	schema: union([
		table,
		put,
		index,
		obj({ kind: lit("dropIndex"), table: str(), name: str() }),
		obj({ kind: lit("alter"), table: str(), version: positive, edit: alter }),
		obj({
			kind: lit("update"),
			table: str(),
			key,
			set: unknown(),
			columns: versions,
			count,
			version: opt(positive),
		}),
		obj({
			kind: lit("updateWhere"),
			table: str(),
			where: unknown(),
			set: unknown(),
			columns: versions,
			count,
			version: opt(positive),
		}),
		obj({ kind: lit("delete"), table: str(), key, count }),
		obj({ kind: lit("deleteWhere"), table: str(), where: unknown(), count }),
		obj({ kind: lit("document.create"), record, base }),
		obj({
			kind: lit("document.change"),
			id: positive,
			revision: positive,
			content: union([
				obj({
					kind: lit("base"),
					version: positive,
					fingerprint: str(),
					value: unknown(),
				}),
				delta,
			]),
		}),
		obj({ kind: lit("document.retire"), id: positive, revision: positive }),
	]),
};
export function checkPart(
	part: unknown,
	position: number,
	context: Context,
): ArchivePart {
	objectsMetrics(context.telemetry.metrics).counter("objects.data.validations").add(1);
	if (!validatorFor(partSchema, context).Check(part))
		throw invalid("args", `import: part ${position}: not an archive part`);
	return part as ArchivePart;
}
export function checkWrite(
	write: unknown,
	what: string,
	context: Context,
): StoreWrite {
	objectsMetrics(context.telemetry.metrics).counter("objects.data.validations").add(1);
	if (!validatorFor(writeSchema, context).Check(write))
		throw invalid("args", `${what}: not a store write`);
	return write as StoreWrite;
}
