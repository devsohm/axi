import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { keyed, local, int, obj } from "../src/next/contracts/index.ts";
import { defineState, type KeyedHandle } from "../src/next/documents/index.ts";
import { createHost, defineFacet } from "../src/next/host/index.ts";

async function notes() {
	const shape = obj({ n: int() });
	const document = defineState("notes", { schema: shape, version: 1, keyed: true, initial: () => ({ n: 0 }) });
	const type = local("test.notes", { version: 1, params: {}, members: { notes: keyed(shape) } });
	const host = createHost({ onError: () => {} });
	let writable!: KeyedHandle<{ n: number }>;
	await host.load(
		[
			{
				name: "notes",
				facet: defineFacet((h) =>
					h.serve(type, (_, self) => {
						writable = self.state(document);
						return { notes: writable };
					}),
				),
			},
		],
		context,
	);
	const first = await host.get(type, {}, context);
	return {
		host,
		first,
		second: () => host.get(type, {}, context),
		write: (n: number) =>
			writable.change(
				"a",
				(value) => {
					value.n = n;
				},
				context,
			),
	};
}
const flushed = () => new Promise<void>((resolve) => setImmediate(resolve));

it("releasing one reference ends its key watch while another reference keeps receiving changes", async () => {
	const app = await notes();
	try {
		await app.write(1);
		const other = await app.second();
		const first = (await app.first.notes.watch("a", context))!;
		const second = (await other.notes.watch("a", context))!;
		first.start(async () => {});
		second.start(async () => {});
		app.first.release();
		expect(await first.closed).toEqual({ kind: "ended" });
		await app.write(2);
		await flushed();
		expect(second.value).toEqual({ n: 2 });
		other.release();
		expect(await second.closed).toEqual({ kind: "ended" });
	} finally {
		await app.host.close(context);
	}
});

it("stopping one watch leaves another watch of the same key attached until it stops", async () => {
	const app = await notes();
	try {
		await app.write(3);
		const first = (await app.first.notes.watch("a", context))!;
		const second = (await app.first.notes.watch("a", context))!;
		first.start(async () => {});
		second.start(async () => {});
		expect(await first.stop()).toEqual({ kind: "stopped" });
		await app.write(4);
		await flushed();
		expect(second.value).toEqual({ n: 4 });
		expect(await second.stop()).toEqual({ kind: "stopped" });
		expect(await app.first.notes.get("a", context)).toEqual({ n: 4 });
		app.first.release();
		await expect(app.first.notes.get("a", context)).rejects.toMatchObject({ code: "released" });
	} finally {
		await app.host.close(context);
	}
});
