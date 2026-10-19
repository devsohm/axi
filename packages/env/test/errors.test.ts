import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "@axi/chord/context";
import { Connection, RemoteError, type RemoteInfo } from "../src/connection.ts";
import { toFileError } from "../src/errors.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";

it("captures the remote path before reading its code once", () => {
	const reads: string[] = [];
	let codes = 0;
	const cause = new RemoteError({ code: "ENOENT", message: "missing" });
	Object.defineProperties(cause, {
		code: {
			get() {
				reads.push("code");
				return ++codes === 1 ? "ENOENT" : "EISDIR";
			},
		},
		path: {
			get() {
				reads.push("path");
				return "/work/item";
			},
		},
		message: {
			get() {
				reads.push("message");
				return "missing";
			},
		},
	});
	const error = toFileError(cause);
	expect(error.code).toBe("not_found");
	expect(error.path).toBe("/work/item");
	expect(reads).toEqual(["path", "code", "message"]);
});

it.each([
	["ENOENT", "not_found"],
	["not-a-code", "unknown"],
	["__proto__", "unknown"],
	["constructor", "unknown"],
	["toString", "unknown"],
])("maps remote error %s to %s", (remote, expected) => {
	const cause = new RemoteError({ code: remote, message: "read failed" });
	const error = toFileError(cause, "/work/file");
	expect(error.code).toBe(expected);
	expect(error.path).toBe("/work/file");
	expect(error.cause).toBe(cause);
});

class MetadataConnection extends Connection {
	override async info(): Promise<RemoteInfo> {
		return {
			protocol: 1,
			version: "test",
			os: "linux",
			arch: "x86_64",
			home: "/home/guest",
			tmpdir: "/tmp",
			separator: "/",
			cwd: "/work",
			driveCwds: {},
			pid: 1,
		};
	}
	override async request(): Promise<never> {
		throw new Error("Unexpected remote request");
	}
}
const environment = new RemoteExecutionEnv({
	connection: new MetadataConnection({ command: [] }),
	id: "context-errors",
	cwd: "/work",
});
const operations: Record<string, (context: Context) => Promise<unknown>> = {
	fileInfo: (context) => environment.fileInfo("item", context),
	canonicalPath: (context) => environment.canonicalPath("item", context),
	flushFile: (context) => environment.flushFile("item", context),
	appendFile: (context) => environment.appendFile("item", "", context),
	truncateFile: (context) => environment.truncateFile("item", 0, context),
	createDir: (context) => environment.createDir("item", undefined, context),
	remove: (context) => environment.remove("item", undefined, context),
	openBinaryReader: (context) => environment.openBinaryReader("item", undefined, context),
	openTextLineReader: (context) => environment.openTextLineReader("item", context),
	openDirReader: (context) => environment.openDirReader("item", context),
	listDir: (context) => environment.listDir("item", context),
};
it.each(Object.entries(operations))("propagates context lookup failures from %s", async (_name, operation) => {
	const cause = new Error("context lookup failed");
	const context: Context = {
		telemetry: BACKGROUND_CONTEXT.telemetry,
		get abortSignal(): AbortSignal | undefined {
			throw cause;
		},
		value: (key) => BACKGROUND_CONTEXT.value(key),
		toString: () => "failing-context",
	};
	await expect(operation(context)).rejects.toBe(cause);
});
