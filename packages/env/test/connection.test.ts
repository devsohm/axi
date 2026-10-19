import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Connection, isConnectionLost } from "../src/connection.ts";

const command = [process.execPath, fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url))];
it("captures the command factory once and invokes it without a receiver", async () => {
	let reads = 0;
	let receiver: unknown = "not called";
	const connection = new Connection({
		get command() {
			reads++;
			return async function (this: unknown) {
				receiver = this;
				return command;
			};
		},
	});
	try {
		expect((await connection.info()).protocol).toBe(1);
		expect(reads).toBe(1);
		expect(receiver).toBeUndefined();
	} finally {
		connection.close();
	}
});
it("synchronizes after shell output and separates concurrent binary replies", async () => {
	const logs: string[] = [];
	const connection = new Connection({ command, onLog: (text) => logs.push(text) });
	try {
		const events: number[] = [];
		const requests = Array.from({ length: 12 }, (_, index) =>
			connection.request(
				"echo",
				{ value: index },
				{
					payload: Uint8Array.from({ length: 8193 + index }, () => index),
					onEvent: (_json, bytes) => events.push(bytes.length),
				},
			),
		);
		const replies = await Promise.all(requests);
		expect(replies.map((reply) => reply.json.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		for (const [index, reply] of replies.entries())
			expect(reply.payload).toEqual(Uint8Array.from({ length: 8193 + index }, () => index));
		expect(events).toEqual(Array.from({ length: 12 }, (_, index) => 8193 + index));
		expect(logs).toEqual(["shell startup"]);
		expect((await connection.request("echo", { value: "\ud800" })).json.value).toBe("�");
	} finally {
		connection.close();
	}
});
it("sends cancellation after an already-aborted request", async () => {
	const connection = new Connection({ command });
	try {
		const controller = new AbortController();
		controller.abort();
		await expect(connection.request("hold", {}, { signal: controller.signal })).rejects.toMatchObject({
			code: "aborted",
		});
		expect((await connection.request("echo", { value: "ready" })).json.value).toBe("ready");
	} finally {
		connection.close();
	}
});
it("rejects stale session handles and starts a fresh daemon after loss", async () => {
	const connection = new Connection({ command });
	try {
		const session = await connection.session(),
			first = (await connection.info()).pid;
		await expect(connection.request("drop", {})).rejects.toSatisfy(isConnectionLost);
		await expect(connection.request("echo", {}, { session })).rejects.toSatisfy(isConnectionLost);
		expect((await connection.info()).pid).not.toBe(first);
		expect((await connection.request("echo", { value: 7 })).json.value).toBe(7);
	} finally {
		connection.close();
	}
});
it("fails corrupt frames and retries a command factory after startup failure", async () => {
	let starts = 0;
	const connection = new Connection({
		command: async () => {
			if (++starts === 1) throw new Error("offline");
			return command;
		},
	});
	try {
		await expect(connection.info()).rejects.toMatchObject({ code: "spawn_error", message: "offline" });
		await expect(connection.request("bad", {})).rejects.toSatisfy(isConnectionLost);
		expect((await connection.request("echo", { value: "restored" })).json.value).toBe("restored");
		expect(starts).toBe(3);
	} finally {
		connection.close();
	}
	await expect(connection.info()).rejects.toMatchObject({ code: "unknown", message: "Connection closed" });
});
