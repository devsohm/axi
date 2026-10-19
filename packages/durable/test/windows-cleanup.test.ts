import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { terminate } from "../src/env/node-shell.ts";

const captured = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: captured.spawn,
}));

it("starts a detached Windows process-tree cleanup and contains spawn errors", () => {
	const killer = new EventEmitter();
	captured.spawn.mockReturnValue(killer);
	const child = new ChildProcess();
	Object.defineProperty(child, "pid", { value: 42 });
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!platform) throw new Error("Missing process platform");
	try {
		Object.defineProperty(process, "platform", { value: "win32" });
		terminate(child);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
	expect(captured.spawn).toHaveBeenCalledExactlyOnceWith(
		expect.stringMatching(/System32[\\/]taskkill\.exe$/),
		["/F", "/T", "/PID", "42"],
		{ stdio: "ignore", detached: true, windowsHide: true },
	);
	expect(() => killer.emit("error", new Error("Unavailable"))).not.toThrow();
	expect(killer.listenerCount("error")).toBe(0);
});
