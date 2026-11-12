import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const displayAvailable = supported && !spawnSync("Xvfb", ["-help"], { stdio: "ignore" }).error;
const x11Available = displayAvailable && !spawnSync("xclip", ["-help"], { stdio: "ignore" }).error;
const ownerAvailable = displayAvailable && spawnSync("pkg-config", ["--exists", "xcb"]).status === 0;
test(
	"X11 falls back after refused targets and rejects interrupted incremental transfers",
	{ skip: !ownerAvailable, timeout: 20000 },
	async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "axi-x11-owner-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const ownerPath = join(directory, "owner");
		execFileSync(process.env.CC ?? "cc", [
			"-std=c11",
			"-Wall",
			"-Wextra",
			"-Werror",
			fileURLToPath(new URL("./test/x11-owner.c", import.meta.url)),
			"-lxcb",
			"-o",
			ownerPath,
		]);
		async function start(command, args, env) {
			const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
			t.after(async () => {
				if (child.exitCode === null && child.signalCode === null) {
					const exited = once(child, "exit");
					child.kill("SIGKILL");
					await exited;
				}
			});
			let errors = "";
			child.stderr.on("data", (data) => (errors += data));
			const ready = await Promise.race([
				once(child.stdout, "data").then(([data]) => data.toString().trim()),
				once(child, "exit").then(([code]) => {
					throw new Error(`${command} ${code}: ${errors}`);
				}),
			]);
			return { child, ready };
		}
		const display = await start(
			"Xvfb",
			["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp"],
			process.env,
		);
		const env = { ...process.env, DISPLAY: `:${display.ready}` };
		const modulePath = fileURLToPath(
			new URL(`./linux/prebuilds/linux-${process.arch}/linux-platform-x11.node`, import.meta.url),
		);
		const reader = `
			const assert = require('node:assert/strict');
			const native = require(process.argv[1]);
			(async () => {
				if (process.argv[2] === 'fallback') assert.equal(await native.getText(), 'fallback 文字');
				else {
					let ticks = 0;
					const timer = setInterval(() => ticks++, 5);
					try { await assert.rejects(native[process.argv[3]](), /X11 clipboard/); }
					finally { clearInterval(timer); }
					if (process.argv[2] === 'stall') assert.ok(ticks > 0, 'transfer must not block JS');
				}
			})().catch(error => { console.error(error); process.exitCode = 1; });
		`;
		for (const [mode, method] of [
			["fallback", "getText"],
			["mismatch", "getText"],
			["mismatch", "getImage"],
			["stall", "getText"],
			["stall", "getImage"],
		]) {
			const { child } = await start(ownerPath, [mode], env);
			try {
				const result = spawnSync(process.execPath, ["-e", reader, modulePath, mode, method], {
					env,
					encoding: "utf8",
					timeout: 5000,
				});
				assert.ifError(result.error);
				assert.equal(result.status, 0, `${mode}/${method}: ${result.stderr}`);
			} finally {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		}
	},
);
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
		skip:
			process.arch !== "arm64" &&
			!existsSync(new URL("./linux/prebuilds/linux-arm64/linux-platform-x11.node", import.meta.url)),
	},
	() => {
		const bytes = readFileSync(new URL("./linux/prebuilds/linux-arm64/linux-platform-x11.node", import.meta.url));
		assert.equal(bytes.readUInt32LE(0), 0x464c457f);
		assert.equal(bytes.readUInt16LE(18), 183);
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
