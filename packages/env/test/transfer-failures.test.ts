import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { getOrThrow } from "@axi/durable/env";
import { expect, test } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";
import { RemoteError } from "../src/connection.ts";

async function openEnvironment() {
	const cwd = await mkdtemp(join(tmpdir(), "axi-transfer-failure-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "transfer-failure", cwd });
	return {
		cwd,
		connection,
		env,
		async [Symbol.asyncDispose]() {
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

test("large transfers preserve bytes after filling more than one pipeline window", async () => {
	await using fixture = await openEnvironment();
	const bytes = Uint8Array.from({ length: 11 * 524288 + 19 }, (_, index) => index % 251);
	getOrThrow(await fixture.env.writeFile("large", bytes, context));
	const stored = await readFile(join(fixture.cwd, "large"));
	expect(stored.equals(bytes)).toBe(true);
	expect(Buffer.from(getOrThrow(await fixture.env.readBinaryFile("large", context))).equals(bytes)).toBe(true);
});

test.each(["abort", "failure", "failure-and-abort"] as const)(
	"an interrupted chunk transfer releases its remote handle and permits a later write: %s",
	async (mode) => {
		await using fixture = await openEnvironment();
		const { connection, env, cwd } = fixture;
		const request = connection.request.bind(connection);
		const controller = new AbortController();
		let closed = 0;
		connection.request = async (op, fields, options) => {
			if (op === "writeChunk" && mode !== "abort") {
				if (mode === "failure-and-abort") controller.abort();
				throw new RemoteError({ code: "EACCES", message: "Cannot write the next chunk" });
			}
			const response = await request(op, fields, options);
			if (op === "write" && mode === "abort") controller.abort();
			if (op === "close") closed++;
			return response;
		};
		try {
			const bytes = new Uint8Array(3 * 524288).fill(37);
			const result = await env.writeFile("partial", bytes, { ...context, abortSignal: controller.signal });
			expect(result).toMatchObject({
				ok: false,
				error: { code: mode === "abort" ? "aborted" : "permission_denied", path: join(cwd, "partial") },
			});
			expect(closed).toBe(1);
			expect((await readFile(join(cwd, "partial"))).equals(bytes.subarray(0, 524288))).toBe(true);
			connection.request = request;
			getOrThrow(await env.writeFile("partial", "recovered", context));
			expect(getOrThrow(await env.readTextFile("partial", context))).toBe("recovered");
		} finally {
			connection.request = request;
		}
	},
);

test.each(["binary", "text"] as const)(
	"a failed open stat closes the %s reader before reporting the error",
	async (kind) => {
		await using fixture = await openEnvironment();
		const { connection, env, cwd } = fixture;
		getOrThrow(await env.writeFile("data", "one\ntwo", context));
		const request = connection.request.bind(connection);
		let closed = 0;
		connection.request = async (op, fields, options) => {
			const response = await request(op, fields, options);
			if (op === "close") closed++;
			return op === "open"
				? { ...response, json: { ...response.json, statError: { code: "EACCES", message: "Cannot stat the file" } } }
				: response;
		};
		try {
			const result =
				kind === "binary" ? await env.readBinaryFile("data", context) : await env.readTextFile("data", context);
			expect(result).toMatchObject({ ok: false, error: { code: "permission_denied", path: join(cwd, "data") } });
			expect(closed).toBe(1);
			connection.request = request;
			expect(getOrThrow(await env.readTextLines("data", undefined, context))).toEqual(["one", "two"]);
		} finally {
			connection.request = request;
		}
	},
);

test("readTextLines reports open and mid-stream failures without retaining a handle", async () => {
	await using fixture = await openEnvironment();
	const { connection, env, cwd } = fixture;
	expect(await env.readTextLines("absent", undefined, context)).toMatchObject({
		ok: false,
		error: { code: "not_found", path: join(cwd, "absent") },
	});
	getOrThrow(await env.writeFile("data", "one\ntwo\n", context));
	const request = connection.request.bind(connection);
	let closed = 0;
	connection.request = async (op, fields, options) => {
		if (op === "pread") throw new RemoteError({ code: "EIO", message: "Read interrupted" });
		const response = await request(op, fields, options);
		if (op === "close") closed++;
		return response;
	};
	try {
		expect(await env.readTextLines("data", undefined, context)).toMatchObject({
			ok: false,
			error: { message: "Read interrupted" },
		});
		expect(closed).toBe(1);
		connection.request = request;
		expect(getOrThrow(await env.readTextLines("data", { maxLines: 1 }, context))).toEqual(["one"]);
	} finally {
		connection.request = request;
	}
});
