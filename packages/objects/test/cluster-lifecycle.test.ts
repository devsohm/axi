import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { createHost, hostNamed, memoryLinkPair, method, remote, type Ctx, type Facet } from "../src/index.ts";

const Notebook = remote("notebook", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("worker"),
	variants: { main: { state: { text: Type.String() }, methods: { append: method(Type.String(), Type.String()) } } },
});
function implementation(version: string, fail = false): Facet {
	return {
		name: "notebook",
		setup(api) {
			api.serve(Notebook, (_input, _principal, self) => {
				if (fail) throw new Error("Notebook cannot prepare");
				const text = self.state("text", Type.String(), "");
				return {
					variant: "main",
					text,
					append(value: string, context: Ctx) {
						text.change(context, (prior) => prior + value);
						return `${version}:${text.value}`;
					},
				};
			});
		},
	};
}
async function cluster() {
	let module = implementation("one");
	const parent = createHost({ name: "controller", self: null });
	const [down, up] = memoryLinkPair();
	parent.accept(down, { name: "worker", kind: "host", principal: null });
	const worker = createHost({
		name: "worker",
		self: null,
		upstream: { link: up, principal: null },
		loader: async () => [module],
	});
	await worker.install(module);
	const reference = await parent.get(Notebook, {});
	return {
		parent,
		worker,
		reference,
		replace(version: string, fail = false) {
			module = implementation(version, fail);
		},
		async close() {
			reference.release();
			await worker.close();
			await parent.close();
		},
	};
}

test("cluster reload preserves object state while old roots finish on their admitted code", async () => {
	const c = await cluster();
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	try {
		expect(await c.reference.append("A")).toBe("one:A");
		const old = c.parent.root(async (context) => {
			expect(await c.reference.append("B", context)).toBe("one:AB");
			entered.resolve();
			await gate.promise;
			return c.reference.append("D", context);
		});
		await entered.promise;
		c.replace("two");
		const report = await c.parent.reload([], { remote: { worker: ["notebook"] } });
		expect(await c.reference.append("C")).toBe("two:ABC");
		expect([c.parent.codeVersion, c.worker.codeVersion]).toEqual([report.codeVersion, report.codeVersion]);
		gate.resolve();
		expect(await old).toBe("one:ABCD");
		await vi.waitFor(() =>
			expect([c.parent.previousCodeVersion, c.worker.previousCodeVersion]).toEqual([undefined, undefined]),
		);
		expect(await c.reference.append("E")).toBe("two:ABCDE");
	} finally {
		gate.resolve();
		await c.close();
	}
});

test("a failed child preparation leaves every participant and live object on the last successful version", async () => {
	const c = await cluster();
	try {
		expect(await c.reference.append("saved")).toBe("one:saved");
		const versions = [c.parent.codeVersion, c.worker.codeVersion];
		c.replace("bad", true);
		await expect(c.parent.reload([], { remote: { worker: ["notebook"] } })).rejects.toMatchObject({
			code: "unavailable",
			message: expect.stringContaining("Notebook cannot prepare"),
		});
		expect([c.parent.codeVersion, c.worker.codeVersion]).toEqual(versions);
		expect(await c.reference.append("!")).toBe("one:saved!");
		c.replace("three");
		await c.parent.reload([], { remote: { worker: ["notebook"] } });
		expect(await c.reference.append("?")).toBe("three:saved!?");
	} finally {
		await c.close();
	}
});
