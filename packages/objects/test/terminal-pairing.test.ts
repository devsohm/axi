import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { tokenOf } from "../src/node/tui/credentials.ts";

const directories: string[] = [];
const url = new URL("https://pairing.example/application/");

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("polls until approval and optionally saves a private token without replacing an existing file", async () => {
	vi.useFakeTimers();
	const directory = await mkdtemp(join(tmpdir(), "axi-pairing-"));
	directories.push(directory);
	const save = join(directory, "device-token");
	for (const [destination, saved] of [
		[undefined, undefined],
		[save, "new-device-token\n"],
		[save, "retained\n"],
	] as const) {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ code: "DVC-2026", poll: "pending-id" }))
			.mockResolvedValueOnce(Response.json({ status: "waiting" }))
			.mockResolvedValueOnce(Response.json({ status: "approved" }))
			.mockResolvedValueOnce(Response.json({ status: "approved", token: "new-device-token" }));
		vi.stubGlobal("fetch", request);
		const say = vi.fn();
		const signal = new AbortController().signal;
		const pairing = tokenOf({ kind: "pairing", label: "workstation", save: destination }, url, say, signal);
		await vi.advanceTimersByTimeAsync(6000);
		await expect(pairing).resolves.toBe("new-device-token");
		expect(say).toHaveBeenCalledExactlyOnceWith(
			"Pairing code DVC-2026: approve it at https://pairing.example/_objects/pair/DVC-2026 (signed in as the owner).",
		);
		expect(
			request.mock.calls.map(([target, options]) => [
				String(target),
				options?.method,
				JSON.parse(String(options?.body)),
			]),
		).toEqual([
			["https://pairing.example/_objects/pair", "POST", { label: "workstation" }],
			...Array.from({ length: 3 }, () => [
				"https://pairing.example/_objects/pair/poll",
				"POST",
				{ poll: "pending-id" },
			]),
		]);
		for (const [, options] of request.mock.calls) {
			expect(options?.signal).toBe(signal);
			expect(options?.headers).toEqual({ "content-type": "application/json" });
		}
		if (destination !== undefined) {
			expect(await readFile(save, "utf8")).toBe(saved);
			if (process.platform !== "win32") expect((await stat(save)).mode & 0o777).toBe(0o600);
			await writeFile(save, "retained\n");
		}
	}
});

it.each([
	{ status: 403, answer: {}, message: "refused to pair" },
	{ status: 200, answer: { code: "", poll: "id" }, message: "malformed" },
	{ status: 200, answer: { code: "unsafe_code", poll: "id" }, message: "malformed" },
	{ status: 200, answer: { code: "X".repeat(33), poll: "id" }, message: "malformed" },
	{ status: 200, answer: { code: "SAFE-123", poll: null }, message: "malformed" },
])(
	"rejects an unusable pairing response before displaying or polling it: $answer",
	async ({ status, answer, message }) => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer, { status }));
		vi.stubGlobal("fetch", request);
		const say = vi.fn();
		await expect(tokenOf({ kind: "pairing", label: "device" }, url, say, new AbortController().signal)).rejects.toThrow(
			message,
		);
		expect(request).toHaveBeenCalledTimes(1);
		expect(say).not.toHaveBeenCalled();
	},
);

it.each(["cancelled", "refused"] as const)("ends a pending pairing when %s", async (ending) => {
	vi.useFakeTimers();
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.json({ code: "DVC-2026", poll: "pending-id" }))
		.mockResolvedValueOnce(new Response(null, { status: 410 }));
	vi.stubGlobal("fetch", request);
	const controller = new AbortController();
	const pending = tokenOf({ kind: "pairing", label: "device" }, url, () => {}, controller.signal);
	const rejected = expect(pending).rejects.toThrow(ending === "cancelled" ? "cancel pairing" : "without approval");
	if (ending === "cancelled") controller.abort(new Error("cancel pairing"));
	await vi.advanceTimersByTimeAsync(2000);
	await rejected;
	expect(request).toHaveBeenCalledTimes(ending === "cancelled" ? 1 : 2);
});
