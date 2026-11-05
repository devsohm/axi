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
	const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
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
