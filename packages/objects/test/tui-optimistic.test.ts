import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost } from "../src/host/index.ts";
import { TuiScope } from "../src/tui/scope.ts";

it("keeps the latest optimistic value through overlapping calls and stops redraws at disposal", async () => {
	const host = createHost({ onError() {} });
	await host.load([], context);
	const changed = vi.fn();
	const scope = new TuiScope(host, changed);
	const [read, show] = scope.optimistic(() => "saved");
	const first = Promise.withResolvers<void>(),
		second = Promise.withResolvers<void>();
	try {
		expect(show("first", first.promise)).toBe(first.promise);
		expect(show("second", second.promise)).toBe(second.promise);
		first.reject(new Error("first failed"));
		await expect(first.promise).rejects.toThrow("first failed");
		expect(read()).toBe("second");
		expect(changed).toHaveBeenCalledTimes(3);
		scope.dispose();
		second.resolve();
		await second.promise;
		expect(read()).toBe("saved");
		expect(changed).toHaveBeenCalledTimes(3);
	} finally {
		scope.dispose();
		await host.close(context);
	}
});

it("reduces pending actions over the latest server value and preserves unchanged result identity", async () => {
	const host = createHost({ onError() {} });
	await host.load([], context);
	const scope = new TuiScope(host, () => {});
	let server = [1, 2, 3];
	const [read, add, pending] = scope.optimistic(
		() => server,
		(items, removed: number) => items.filter((item) => item !== removed),
	);
	const first = Promise.withResolvers<void>(),
		second = Promise.withResolvers<void>();
	try {
		expect(pending()).toBe(false);
		expect(add(1, first.promise)).toBe(first.promise);
		add(3, second.promise);
		expect(read()).toEqual([2]);
		expect(read()).toBe(read());
		server = [2, 3, 4];
		first.resolve();
		await first.promise;
		expect(pending()).toBe(true);
		expect(read()).toEqual([2, 4]);
		second.reject(new Error("write refused"));
		await expect(second.promise).rejects.toThrow("write refused");
		expect(pending()).toBe(false);
		expect(read()).toBe(server);
	} finally {
		scope.dispose();
		await host.close(context);
	}
});
