import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { constant, createHost, defineFacet, defineRegistry, int, local } from "../src/index.ts";
import { TuiScope } from "../src/tui/scope.ts";
import type { Watchable } from "../src/watch.ts";

test("terminal scope references and registry readers follow reload and release on disposal", async () => {
	const item = local("terminal.item", { version: 1, params: {}, members: { value: int() } });
	const totals = defineRegistry<number, number>("terminal.total", { version: 1 });
	const plugin = (value: number) => ({
		name: "terminal",
		facet: defineFacet((host, self) => {
			host.serve(item, () => ({ value: constant(value) }));
			host.serve(totals, { compose: (table) => table.reduce((sum, row) => sum + row.value, 0) });
			self.contribute(totals, value);
		}),
	});
	const host = createHost({ onError() {} });
	const changed = vi.fn();
	const scope = new TuiScope(host, changed);
	try {
		await host.load([plugin(3)], context);
		const held = scope.hold(item, {});
		const value = scope.watch(held.value);
		const total = scope.registry(totals);
		expect(total()).toBeUndefined();
		await vi.waitFor(() => expect([held.state.value.kind, value(), total()]).toEqual(["live", 3, 3]));
		await host.reload([plugin(7)], context);
		await vi.waitFor(() => expect([value(), total()]).toEqual([7, 7]));
		expect(changed).toHaveBeenCalled();
		scope.dispose();
		scope.dispose();
		expect(held.state.value.kind).toBe("ended");
		changed.mockClear();
		await host.reload([plugin(9)], context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(changed).not.toHaveBeenCalled();
	} finally {
		scope.dispose();
		await host.close(context);
	}
});

test("a failed watch stays readable as absent and cannot redraw a disposed terminal scope", async () => {
	const host = createHost({ onError() {} });
	const changed = vi.fn();
	const scope = new TuiScope(host, changed);
	const source: Watchable<number> = {
		get value(): number {
			throw new Error("not available");
		},
		async watch() {
			throw new Error("subscription refused");
		},
	};
	try {
		await host.load([], context);
		const value = scope.watch(source);
		expect(value()).toBeUndefined();
		scope.dispose();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(value()).toBeUndefined();
		expect(changed).not.toHaveBeenCalled();
	} finally {
		scope.dispose();
		await host.close(context);
	}
});
