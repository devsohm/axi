import { expect, it, vi } from "vitest";
import { local } from "../src/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import { checkDependencies, ParkedLong } from "../src/host/dependencies.ts";
import { Binding } from "../src/host/reference.ts";
import type { HostError } from "../src/host/report.ts";
import { Batch } from "../src/state/internal.ts";

it("parks on recoverable failures and breaks on lost authority or an ended dependency", () => {
	const type = local("app.dependency", { version: 1, params: {}, members: {} }),
		batch = new Batch(() => {}, undefined);
	const binding = new Binding(type, batch, undefined, { principal: undefined, incarnation: "host" }, 100);
	expect(checkDependencies([])).toEqual({ kind: "live" });
	expect(checkDependencies([{ kind: "reference", binding }])).toEqual({
		kind: "parked",
		shown: { kind: "loading" },
		firstPass: true,
		blocker: { label: "app.dependency", state: "loading" },
		loadingOn: "app.dependency",
	});
	const forbidden = new ObjectsError({ code: "forbidden", message: "denied" });
	binding.refuse({ kind: "broken", error: forbidden }, () => {});
	expect(checkDependencies([{ kind: "reference", binding }])).toEqual({
		kind: "broken",
		error: forbidden,
	});
	binding.release();
	expect(checkDependencies([{ kind: "reference", binding }])).toMatchObject({
		kind: "broken",
		error: { code: "released" },
	});
});
it("reports the current blocker once for the whole parking episode", async () => {
	vi.useFakeTimers();
	try {
		vi.setSystemTime(100);
		const reports: HostError[] = [],
			parking = new ParkedLong({
				label: "app",
				host: {
					timeouts: { ready: 20 },
					report: (error) => {
						reports.push(error);
					},
				},
			});
		parking.blockedBy({ label: "first", state: "loading" });
		await vi.advanceTimersByTimeAsync(10);
		parking.blockedBy({ label: "second", state: "failed" });
		await vi.advanceTimersByTimeAsync(10);
		expect(reports).toEqual([
			{ kind: "parked_long", object: "app", waitingFor: "second", state: "failed", since: 100 },
		]);
		parking.blockedBy({ label: "third", state: "loading" });
		await vi.advanceTimersByTimeAsync(100);
		expect(reports).toHaveLength(1);
		parking.stop();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
	}
});
