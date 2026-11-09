import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { keyed, local, int, obj } from "../src/contracts/index.ts";
import { defineState, type KeyedHandle } from "../src/documents/index.ts";
import { createHost, defineFacet } from "../src/host/index.ts";

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

it("keeps a pending key watch open through a failed first startup and retry", async () => {
	const shape = obj({ n: int() });
	const document = defineState("docs", { schema: shape, version: 1, keyed: true, initial: () => ({ n: 0 }) });
	const type = local("test.starting", { version: 1, params: {}, members: { docs: keyed(shape) } });
	const host = createHost({ onError() {} });
	let attempts = 0;
	try {
		await host.load([{ name: "starting", facet: defineFacet((h) => h.serve(type, (_, self) => {
			self.open(async () => {
				if (++attempts === 1) throw new Error("not ready");
				return null;
			}, () => {});
			return { docs: self.state(document) };
		})) }], context);
		const ref = host.hold(type, {}, context);
		const settled: unknown[] = [];
		const pending = ref.docs.watch("missing", context).then(
			(watch) => { settled.push(watch); },
			(error: unknown) => { settled.push(error); },
		);
		await vi.waitFor(() => expect(ref.state.value.kind).toBe("failed"));
		expect(settled).toEqual([]);
		ref.retry();
		await pending;
		expect(settled).toEqual([undefined]);
		expect(ref.state.value.kind).toBe("live");
		ref.release();
	} finally {
		await host.close(context);
	}
});

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
