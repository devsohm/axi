const token = process.argv[process.argv.indexOf("--token") + 1];
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
			send(3, id, { code: "aborted", message: "aborted" });
			continue;
		}
		if (type !== 1) continue;
		if (json.op === "hello")
			send(2, id, {
				protocol: 1,
				version: "0.0.0",
				os: "linux",
				arch: "x86_64",
				home: "/home/test",
				tmpdir: "/tmp",
				separator: "/",
				cwd: "/",
				driveCwds: {},
				pid: process.pid,
			});
		else if (json.op === "echo") {
			send(4, id, { kind: "progress" }, payload);
			send(2, id, { value: json.value }, payload);
		} else if (json.op === "drop") process.exit(0);
		else if (json.op === "bad") send(2, id, []);
		else if (json.op !== "hold") send(3, id, { code: "EINVAL", message: "unknown operation" });
	}
});
process.stdin.on("end", () => process.exit(0));
