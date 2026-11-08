const token = process.argv[process.argv.indexOf("--token") + 1];
const silent = process.argv.includes("--silent");
const windows = process.argv.includes("--windows");
const watchEventsAt = process.argv.indexOf("--watch-events");
const protocolAt = process.argv.indexOf("--protocol");
if (process.argv.includes("--long-preamble")) process.stdout.write("x".repeat(2 * 1024 * 1024));
process.stdout.write("shell startup\nAX");
await new Promise<void>((resolve) => setImmediate(resolve));
process.stdout.write(`I-ENV ${token}\n`);
let buffer: Buffer = Buffer.alloc(0);
function send(type: number, id: number, json: unknown, payload: Uint8Array = new Uint8Array(0)): void {
	const body = Buffer.from(JSON.stringify(json));
	const frame = Buffer.alloc(13 + body.length + payload.length);
	frame.writeUInt32BE(frame.length - 4, 0);
	frame.writeUInt8(type, 4);
	frame.writeUInt32BE(id, 5);
	frame.writeUInt32BE(body.length, 9);
	body.copy(frame, 13);
	frame.set(payload, 13 + body.length);
	process.stdout.write(frame.subarray(0, 3));
	process.stdout.write(frame.subarray(3));
}
process.stdin.on("data", (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
		const length = buffer.readUInt32BE(),
			type = buffer[4]!,
			id = buffer.readUInt32BE(5),
			size = buffer.readUInt32BE(9);
		const json: Record<string, unknown> = JSON.parse(buffer.subarray(13, 13 + size).toString("utf8"));
		const payload = new Uint8Array(buffer.subarray(13 + size, 4 + length));
		buffer = buffer.subarray(length + 4);
		if (type === 5) {
			if (!silent) send(3, id, { code: "aborted", message: "aborted" });
			continue;
		}
		if (type !== 1) continue;
		if (json.op === "hello" && process.argv.includes("--no-hello")) continue;
		if (json.op === "hello")
			send(2, id, {
				protocol: protocolAt < 0 ? 1 : Number(process.argv[protocolAt + 1]),
				version: "0.0.0",
				os: windows ? "windows" : "linux",
				arch: "x86_64",
				home: windows ? "C:\\Users\\Tester" : "/home/test",
				tmpdir: windows ? "C:\\Temp" : "/tmp",
				separator: windows ? "\\" : "/",
				cwd: windows ? "C:\\remote" : "/",
				driveCwds: windows ? { "D:": "D:\\other", "E:": "C:\\wrong-drive" } : {},
				pid: process.pid,
			});
		else if (silent) continue;
		else if (json.op === "echo") {
			send(4, id, { kind: "progress" }, payload);
			send(2, id, { value: json.value }, payload);
		} else if (json.op === "drop") process.exit(0);
		else if (json.op === "raw") {
			process.stdout.write(payload);
			send(2, id, { accepted: true });
		} else if (json.op === "remote-error") send(3, id, json.error);
		else if (json.op === "watch" && process.argv.includes("--watch-denied"))
			send(3, id, { code: "EACCES", message: "watch denied" });
		else if (json.op === "watch" && watchEventsAt >= 0) {
			for (const event of JSON.parse(process.argv[watchEventsAt + 1]!)) send(4, id, event);
			send(2, id, {});
		} else if (json.op === "watch" && process.argv.includes("--watch-hold"))
			send(4, id, { kind: "ready", mode: "native" });
		else if (json.op === "bad") send(2, id, []);
		else if (json.op !== "hold") send(3, id, { code: "EINVAL", message: "unknown operation" });
	}
});
process.stdin.on("end", () => process.exit(0));
