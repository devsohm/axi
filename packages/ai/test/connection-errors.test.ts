import { expect, test } from "vitest";
import { normalizeProviderError, withCauseDetail } from "../src/utils/error-body.ts";

test("connection failures retain their deepest bounded cause without changing HTTP error bodies", () => {
	const reason = Object.assign(new Error("socket refused"), { code: "ECONNREFUSED" });
	const error = new Error("Connection error.", { cause: new Error("fetch failed", { cause: reason }) });
	expect(withCauseDetail(error)).toBe("Connection error.: socket refused (ECONNREFUSED)");
	expect(normalizeProviderError(error).message).toBe(withCauseDetail(error));
	const http = Object.assign(error, { status: 403, body: "denied" });
	expect(normalizeProviderError(http).message).toBe("Connection error.");
	const cycle = new Error("cycle");
	cycle.cause = cycle;
	expect(withCauseDetail(cycle)).toBe("cycle");
});
