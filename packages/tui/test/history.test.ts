import { describe, expect, it } from "vitest";
import { KillRing } from "../src/kill-ring.ts";
import { UndoStack } from "../src/undo-stack.ts";

describe("deleted-text history", () => {
	it("accumulates deletions in either direction and cycles entries", () => {
		const ring = new KillRing();
		ring.push("", { prepend: false });
		expect(ring.length).toBe(0);
		ring.push("middle", { prepend: false });
		ring.push("left-", { prepend: true, accumulate: true });
		ring.push("-right", { prepend: false, accumulate: true });
		expect(ring.peek()).toBe("left-middle-right");
		ring.push("new", { prepend: false });
		ring.rotate();
		expect(ring.peek()).toBe("left-middle-right");
		ring.rotate();
		expect(ring.peek()).toBe("new");
		expect(ring.length).toBe(2);
	});

	it("leaves empty and single-entry rings unchanged on rotation", () => {
		const ring = new KillRing();
		ring.rotate();
		expect(ring.peek()).toBeUndefined();
		ring.push("one", { prepend: true, accumulate: true });
		ring.rotate();
		expect(ring.peek()).toBe("one");
	});
});

describe("undo snapshots", () => {
	it("detaches nested values at push time and pops in reverse order", () => {
		const stack = new UndoStack<{ lines: string[] }>();
		const state = { lines: ["first"] };
		stack.push(state);
		state.lines.push("second");
		stack.push(state);
		expect(stack.pop()).toEqual({ lines: ["first", "second"] });
		expect(stack.pop()).toEqual({ lines: ["first"] });
		expect(stack.pop()).toBeUndefined();
		expect(stack.length).toBe(0);
	});

	it("clears snapshots and leaves the stack usable", () => {
		const stack = new UndoStack<number>();
		stack.push(1);
		stack.clear();
		expect(stack.pop()).toBeUndefined();
		stack.push(2);
		expect(stack.pop()).toBe(2);
	});
});
