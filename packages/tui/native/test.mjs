import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const supported = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);

test(
	"X11 connection setup stays responsive and bounds concurrent work",
	{ skip: !supported, timeout: 9000 },
	async () => {
		const native = require(`./linux/prebuilds/linux-${process.arch}/linux-platform-x11.node`);
		const previous = process.env.DISPLAY;
		let count = 0,
			ticks = 0;
		const sockets = new Set();
		const server = createServer((socket) => {
			count++;
			sockets.add(socket);
			socket.on("data", () => {});
			socket.on("close", () => sockets.delete(socket));
		});
		let interval;
		try {
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			assert.ok(address && typeof address !== "string" && address.port > 6000);
			process.env.DISPLAY = `127.0.0.1:${address.port - 6000}`;
			interval = setInterval(() => ticks++, 20);
			const started = performance.now();
			const first = native.getText();
			while (!count) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(await native.getImage(), undefined);
			assert.equal(await first, undefined);
			assert.ok(performance.now() - started < 3500);
			assert.ok(ticks >= 50);
			assert.equal(count, 1);
			const closed = [...sockets].map((socket) => once(socket, "close"));
			for (const socket of sockets) socket.destroy();
			await Promise.all(closed);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await new Promise((resolve) => server.close(resolve));
			assert.equal(await native.getText(), undefined);
			assert.equal(await native.getImage(), undefined);
		} finally {
			clearInterval(interval);
			for (const socket of sockets) socket.destroy();
			if (server.listening) await new Promise((resolve) => server.close(resolve));
			if (previous === undefined) delete process.env.DISPLAY;
			else process.env.DISPLAY = previous;
		}
	},
);

const x11Available =
	supported && ["Xvfb", "xclip"].every((command) => !spawnSync(command, ["-help"], { stdio: "ignore" }).error);
test(
	"X11 reads empty, Unicode, Latin-1 and incremental image selections",
	{ skip: !x11Available, timeout: 15000 },
	async () => {
		const native = require(`./linux/prebuilds/linux-${process.arch}/linux-platform-x11.node`);
		const previous = process.env.DISPLAY;
		const server = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let errors = "";
		server.stderr.on("data", (data) => (errors += data));
		try {
			const ready = await Promise.race([
				once(server.stdout, "data").then(([data]) => data.toString().trim()),
				once(server, "exit").then(([code]) => {
					throw new Error(`Xvfb ${code}: ${errors}`);
				}),
			]);
			process.env.DISPLAY = ":" + ready;
			assert.equal(await native.getText(), null);
			assert.equal(await native.getImage(), null);
			for (const [target, method, bytes, expected] of [
				["UTF8_STRING", "getText", Buffer.from("café 日本語"), "café 日本語"],
				["STRING", "getText", Buffer.from("café £ÿ", "latin1"), "café £ÿ"],
				["UTF8_STRING", "getText", Buffer.alloc(4 * 1024 * 1024, 120), null],
				["image/png", "getImage", Buffer.alloc(4 * 1024 * 1024, 123), null],
			]) {
				execFileSync("xclip", ["-selection", "clipboard", "-in", "-t", target], {
					env: process.env,
					input: bytes,
					stdio: ["pipe", "ignore", "ignore"],
					timeout: 5000,
				});
				const value = await native[method]();
				if (expected !== null) assert.equal(value, expected);
				else
					assert.equal(
						createHash("sha256").update(value).digest("hex"),
						createHash("sha256").update(bytes).digest("hex"),
					);
			}
		} finally {
			if (server.exitCode === null && server.signalCode === null) {
				const exited = once(server, "exit");
				server.kill("SIGKILL");
				await exited;
			}
			if (previous === undefined) delete process.env.DISPLAY;
			else process.env.DISPLAY = previous;
		}
	},
);

test(
	"native platform helper exports clipboard and modifier entrypoints",
	{
		skip: !["darwin", "win32"].includes(process.platform) || !["x64", "arm64"].includes(process.arch),
	},
	() => {
		const platform = process.platform;
		const helper = require(`./${platform}/prebuilds/${platform}-${process.arch}/${platform}-platform.node`);
		for (const name of ["getText", "getImage", "setText", "isModifierPressed"])
			assert.equal(typeof helper[name], "function", name);
		assert.equal(helper.isModifierPressed("unsupported"), false);
		assert.equal(typeof helper[platform === "darwin" ? "getFilePaths" : "enableVirtualTerminalInput"], "function");
	},
);

test(
	"Linux ARM64 native segments support 64 KiB pages",
	{
		skip: process.platform !== "linux" || process.arch !== "arm64",
	},
	() => {
		const bytes = readFileSync(new URL("./linux/prebuilds/linux-arm64/linux-platform-x11.node", import.meta.url));
		assert.equal(bytes.readUInt32LE(0), 0x464c457f);
		const table = Number(bytes.readBigUInt64LE(32));
		const stride = bytes.readUInt16LE(54),
			count = bytes.readUInt16LE(56);
		let loads = 0;
		for (let i = 0; i < count; i++) {
			const entry = table + i * stride;
			if (bytes.readUInt32LE(entry) !== 1) continue;
			loads++;
			assert.equal((bytes.readBigUInt64LE(entry + 16) - bytes.readBigUInt64LE(entry + 8)) % 65536n, 0n);
			assert.ok(bytes.readBigUInt64LE(entry + 48) >= 65536n);
		}
		assert.ok(loads > 0);
	},
);
