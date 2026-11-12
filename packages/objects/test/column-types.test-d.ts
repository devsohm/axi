import { expectTypeOf } from "vitest";
import { type Address, hostKind, int, opt, str } from "../src/contracts/index.ts";
import { type Columns, describeColumns, type PutRowOf, type RowOf } from "../src/store/columns.ts";
import { host } from "../src/store/host-column.ts";
import { defineTable } from "../src/store/table.ts";

export function checkColumnTypes(): void {
	const Queue = hostKind("queue", { name: str() });
	const columns = { queue: host(Queue), count: int({ default: 0 }), note: opt(str()) } satisfies Columns;
	expectTypeOf<RowOf<typeof columns>["queue"]>().toEqualTypeOf<Address<typeof Queue>>();
	expectTypeOf<PutRowOf<typeof columns>["count"]>().toEqualTypeOf<number | undefined>();
	describeColumns(columns, "queues");
	defineTable("queues", { version: 1, columns, key: ["queue"] });
	const optionalQueue = opt(host(Queue));
	// @ts-expect-error A table row always belongs to its declared host.
	describeColumns({ queue: optionalQueue }, "invalid");
	// @ts-expect-error Table definitions must reject optional host ownership too.
	defineTable("invalid", { version: 1, columns: { queue: optionalQueue }, key: ["queue"] });
}
