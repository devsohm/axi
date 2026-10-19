import { expect, it } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

it("uses successive SDK status reads when selecting a retry", async () => {
	let calls = 0,
		reads = 0;
	const error = new Error("Busy");
	Object.assign(error, { headers: new Headers({ "retry-after-ms": "0" }) });
	Object.defineProperty(error, "status", {
		get() {
			return ++reads === 6 ? 429 : 200;
		},
	});
	const result = await retryProviderRequest(
		async () => {
			if (++calls === 1) throw error;
			return "completed";
		},
		{ maxRetries: 1 },
	);
	expect({ result, calls }).toEqual({ result: "completed", calls: 2 });
});

it("uses the millisecond retry header without reading the fallback header", async () => {
	class RetryHeaders extends Headers {
		get(name: string): string | null {
			if (name === "retry-after") throw new Error("Fallback header must not be read");
			return super.get(name);
		}
	}
	let calls = 0;
	const value = await retryProviderRequest(
		async () => {
			if (++calls === 1)
				throw Object.assign(new Error("Try again"), {
					status: 429,
					headers: new RetryHeaders({ "retry-after-ms": "0" }),
				});
			return "completed";
		},
		{ maxRetries: 1 },
	);
	expect(value).toBe("completed");
	expect(calls).toBe(2);
});
