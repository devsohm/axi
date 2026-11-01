import { expect, it, vi } from "vitest";
import { uuidv7 } from "../src/next/host/uuid.ts";

it("mints unique ordered version-seven identifiers even while the wall clock goes backwards", () => {
	vi.useFakeTimers();
	try {
		vi.setSystemTime(Date.now());
		const ids = Array.from({ length: 1000 }, () => uuidv7());
		vi.setSystemTime(Date.now() - 1000);
		ids.push(uuidv7());
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(ids.toSorted());
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	} finally {
		vi.useRealTimers();
	}
});
