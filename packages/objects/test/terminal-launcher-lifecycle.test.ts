import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { startTerminal, type RunningTerminal } from "../src/node/tui/index.ts";

const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of resources.splice(0).reverse()) await close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function script(input: string, initial = "") {
	return `const bridge = globalThis.objectsBridge;
const report = message => bridge.send({kind:"write",data:JSON.stringify(message)+"\\n"});
${initial}
bridge.send({kind:"write",data:"ready\\n"});
bridge.onMessage(message => { if (message.kind === "input") { ${input} } else report(message); });`;
}

async function fixture(source: string, dimensions = { columns: 80, rows: 24 }) {
	const routes = new Map<string, (response: ServerResponse) => void>();
	const requests: { path: string; authorization: string | undefined }[] = [],
		raw: boolean[] = [];
	const state = { source, base: "first" };
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		requests.push({ path, authorization: request.headers.authorization });
		const route = routes.get(path);
		if (route) route(response);
		else if (path === "/_objects/tui/start")
			response.end(
				JSON.stringify({ base: state.base, script: "/_objects/tui/script", combined: "/_objects/tui/combined" }),
			);
		else if (path === "/_objects/tui/script") response.end(state.source);
		else if (path === "/_objects/tui/combined") response.end("combined-source");
		else if (path === "/_objects/tui/base") response.end(JSON.stringify(state.base));
		else if (path === "/_objects/tui/plugin/asset") response.end("asset text");
		else {
			response.statusCode = 404;
			response.end();
		}
	});
	const sockets = new WebSocketServer({ server, path: "/objects" });
	const input = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode(value: boolean) {
			raw.push(value);
		},
	});
	const output = Object.assign(new PassThrough(), dimensions);
	let painted = "",
		running: RunningTerminal | undefined;
	output.on("data", (chunk: Buffer) => {
		painted += chunk.toString();
	});
	resources.push(async () => {
		await running?.stop();
		for (const socket of sockets.clients) socket.terminate();
		await new Promise<void>((resolve) => sockets.close(() => resolve()));
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		input.destroy();
		output.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture listener");
	return {
		state,
		routes,
		requests,
		input,
		output,
		raw,
		sockets,
		text: () => painted,
		async start() {
			running = await startTerminal({
				url: `http://127.0.0.1:${address.port}/`,
				credentials: { kind: "token", token: "test-launcher" },
				input,
				output,
			});
			return running;
		},
	};
}

test("the sandbox starts through a symlinked temporary-directory ancestor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-terminal-link-"));
	resources.push(() => rm(directory, { recursive: true, force: true }));
	const real = join(directory, "real"),
		link = join(directory, "linked");
	await mkdir(real);
	await symlink(real, link, "junction");
	for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, link);
	const f = await fixture(script(""));
	await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
});

test("terminal requests return assets and base values while refusing foreign paths", async () => {
	const f = await fixture(
		script(`
bridge.send({kind:"request",id:1,request:{kind:"fetch",path:"/_objects/tui/plugin/asset"}});
bridge.send({kind:"request",id:2,request:{kind:"base"}});
bridge.send({kind:"request",id:3,request:{kind:"fetch",path:"https://foreign.invalid/asset"}});`),
	);
	await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	f.input.write("requests");
	await vi.waitFor(() => {
		expect(f.text()).toContain('"kind":"reply","id":1,"value":"asset text"');
		expect(f.text()).toContain('"kind":"reply","id":2,"value":"first"');
		expect(f.text()).toContain('"kind":"refused","id":3');
	});
	expect(f.requests.every((request) => request.authorization === "Bearer test-launcher")).toBe(true);
	expect(f.requests.some((request) => request.path.includes("foreign"))).toBe(false);
});

test.each(["declared", "streamed"] as const)("terminal asset requests reject oversized %s responses", async (mode) => {
	const f = await fixture(
		script('bridge.send({kind:"request",id:1,request:{kind:"fetch",path:"/_objects/tui/plugin/large"}});'),
	);
	f.routes.set("/_objects/tui/plugin/large", (response) => {
		if (mode === "declared") {
			response.setHeader("content-length", 8 * 1024 * 1024 + 1);
			response.end("x");
		} else {
			for (let index = 0; index < 9; index++) response.write(Buffer.alloc(1024 * 1024, 97));
			response.end();
		}
	});
	await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	f.input.write("request");
	await vi.waitFor(() =>
		expect(f.text()).toContain(
			'"kind":"refused","id":1,"message":"terminal: /_objects/tui/plugin/large exceeds 8 MiB"',
		),
	);
});

test("terminal request admission refuses a ninth request while eight asset reads remain pending", async () => {
	const f = await fixture(
		script(
			'for(let id=1;id<=9;id++) bridge.send({kind:"request",id,request:{kind:"fetch",path:"/_objects/tui/plugin/pending"}});',
		),
	);
	const held: ServerResponse[] = [];
	f.routes.set("/_objects/tui/plugin/pending", (response) => held.push(response));
	await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	f.input.write("requests");
	await vi.waitFor(() => {
		expect(held).toHaveLength(8);
		expect(f.text()).toContain('"kind":"refused","id":9,"message":"terminal: too many requests at once"');
	});
	for (const response of held) response.end("released");
	await vi.waitFor(() => expect(f.text().match(/"kind":"reply"/g)).toHaveLength(8));
});

test("terminal socket bridges enforce connection admission and forward bytes in both directions", async () => {
	const f = await fixture(`const bridge=globalThis.objectsBridge;
bridge.send({kind:"write",data:"ready\\n"});
bridge.onMessage(message=>{
 if(message.kind==="input") {for(let socket=1;socket<=5;socket++)bridge.send({kind:"socket_open",socket});}
 else if(message.kind==="socket_opened") bridge.send({kind:"socket_send",socket:message.socket,bytes:new Uint8Array([message.socket,255])});
 else if(message.kind==="socket_message") {bridge.send({kind:"write",data:JSON.stringify({socket:message.socket,bytes:Array.from(message.bytes)})+"\\n"});bridge.send({kind:"socket_close",socket:message.socket});}
 else if(message.kind==="socket_closed")bridge.send({kind:"write",data:"closed:"+message.socket+"\\n"});
});`);
	const received: number[][] = [];
	f.sockets.on("connection", (socket, request) => {
		expect(request.headers.authorization).toBe("Bearer test-launcher");
		socket.on("message", (bytes: Buffer) => {
			received.push([...bytes]);
			socket.send(bytes);
		});
	});
	await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	f.input.write("open");
	await vi.waitFor(() => {
		expect(received).toHaveLength(4);
		expect(f.sockets.clients.size).toBe(0);
		expect(f.text()).toContain("closed:5");
	});
	expect(received.sort((left, right) => left[0]! - right[0]!)).toEqual([
		[1, 255],
		[2, 255],
		[3, 255],
		[4, 255],
	]);
	for (let socket = 1; socket <= 4; socket++)
		expect(f.text()).toContain(JSON.stringify({ socket, bytes: [socket, 255] }));
});

test("terminal consent holds untrusted output, ignores early answers and refuses overlapping prompts", async () => {
	let now = 1000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const f = await fixture(
		script(`
bridge.send({kind:"request",id:1,request:{kind:"copy",text:"approved text"}});
bridge.send({kind:"write",data:"held while consent is open\\n"});
bridge.send({kind:"request",id:2,request:{kind:"copy",text:"second request"}});`),
	);
	const running = await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	f.input.write("copy");
	await vi.waitFor(() => expect(f.text()).toContain("Copy these 13 characters"));
	expect(f.text()).not.toContain("held while consent is open");
	f.input.write("y");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(f.text()).not.toContain("\x1b]52;c;");
	now = 1301;
	f.input.write("Y");
	await vi.waitFor(() => {
		expect(f.text()).toContain(`\x1b]52;c;${Buffer.from("approved text").toString("base64")}\x07`);
		expect(f.text()).toContain('"kind":"reply","id":1,"value":true');
		expect(f.text()).toContain('"kind":"refused","id":2,"message":"terminal: a prompt is open"');
		expect(f.text()).toContain("held while consent is open");
	});
	await running.stop();
	expect(f.raw).toEqual([true, false]);
});

test("a consent prompt that cannot fit returns a refusal and leaves the terminal usable", async () => {
	const f = await fixture(script('bridge.send({kind:"request",id:1,request:{kind:"copy",text:"copy this"}});'), {
		columns: 20,
		rows: 2,
	});
	await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	f.input.write("copy");
	await vi.waitFor(() =>
		expect(f.text()).toContain('"kind":"refused","id":1,"message":"terminal: the prompt does not fit the terminal"'),
	);
	f.output.rows = 12;
	f.output.emit("resize");
	await vi.waitFor(() => expect(f.text()).toContain('"kind":"resize","columns":20,"rows":12'));
});

test("terminal startup and resize forward dimensions, color mode and normalized locale preferences", async () => {
	vi.stubEnv("LANGUAGE", "fr_FR.UTF-8:de_DE");
	vi.stubEnv("LC_ALL", "C");
	vi.stubEnv("LC_MESSAGES", "POSIX");
	vi.stubEnv("LANG", "en_US.UTF-8");
	vi.stubEnv("COLORTERM", "24bit");
	const f = await fixture(script("", "report(bridge.start);"), { columns: 77, rows: 21 });
	await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	expect(f.text()).toContain(
		'"columns":77,"rows":21,"colors":"truecolor","mode":"dark","locales":["fr-FR","de-DE","en-US"',
	);
	f.output.columns = 44;
	f.output.rows = 10;
	f.output.emit("resize");
	await vi.waitFor(() => expect(f.text()).toContain('"kind":"resize","columns":44,"rows":10'));
});

test("outdated terminal code reloads only when the server base changes", async () => {
	const f = await fixture(script('bridge.send({kind:"outdated"});'));
	await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	f.input.write("same");
	await vi.waitFor(() => expect(f.requests.filter((request) => request.path === "/_objects/tui/base")).toHaveLength(1));
	expect(f.requests.filter((request) => request.path === "/_objects/tui/start")).toHaveLength(1);
	f.state.base = "second";
	f.state.source = script(
		'bridge.send({kind:"write",data:"second version input\\n"});',
		'bridge.send({kind:"write",data:"second version loaded\\n"});',
	);
	f.input.write("changed");
	await vi.waitFor(() => expect(f.text()).toContain("second version loaded"));
	f.input.write("test");
	await vi.waitFor(() => expect(f.text()).toContain("second version input"));
	expect(f.requests.filter((request) => request.path === "/_objects/tui/start")).toHaveLength(2);
});

test("failed terminal reload closes its input and restores raw mode", async () => {
	const f = await fixture(script('bridge.send({kind:"outdated"});'));
	const running = await f.start();
	await vi.waitFor(() => expect(f.text()).toContain("ready"));
	f.state.base = "second";
	f.routes.set("/_objects/tui/start", (response) => {
		response.statusCode = 503;
		response.end();
	});
	f.input.write("reload");
	expect(await running.exited).toBe(1);
	expect(f.input.listenerCount("data")).toBe(0);
	expect(f.raw).toEqual([true, false]);
});

test.each(["failure", "exit"] as const)("a sandbox %s restores terminal state and finishes once", async (mode) => {
	const f = await fixture(
		mode === "failure"
			? 'throw new Error("Client startup failed");'
			: 'globalThis.objectsBridge.send({kind:"exit",code:7});',
	);
	const running = await f.start();
	expect(await running.exited).toBe(mode === "failure" ? 1 : 7);
	await running.stop();
	expect(f.raw).toEqual([true, false]);
	expect(f.text()).toContain("\x1b[?1049l");
	expect(f.input.listenerCount("data")).toBe(0);
});
