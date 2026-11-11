import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeStart, LauncherMessage, SandboxMessage } from "../../tui/bridge.ts";
import { FrameReader, launcherFrame, MAX_PIPE_FRAME, startFrame } from "./pipe.ts";
export const MAX_BUNDLE = 8 * 1024 * 1024;
export const BOOTSTRAP_FILE = "bootstrap.cjs";
export const SANDBOX_BUILTINS: readonly string[] =
	"assert assert/strict buffer crypto events path path/posix path/win32 punycode querystring stream stream/consumers stream/promises stream/web string_decoder timers timers/promises url util util/types zlib".split(
		" ",
	);
export const SANDBOX_PROCESS: readonly string[] =
	"addListener arch argv argv0 cwd emit emitWarning env execArgv execPath exit getBuiltinModule hrtime listenerCount listeners nextTick off on once permission platform release removeAllListeners removeListener stderr stdout title uptime version versions".split(
		" ",
	);
export function requireSandboxNode(version = process.versions.node): void {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	if (major > 26 || (major === 26 && (minor > 5 || (minor === 5 && patch >= 1)))) return;
	throw new Error(`the terminal client needs Node 26.5.1 or later for its sandbox (this is Node ${version})`);
}
export function sandboxFlags(script: string): string[] {
	return ["--permission", `--allow-fs-read=${script}`, "--no-experimental-sqlite", "--max-old-space-size=96", script];
}
export function sandboxEnvironment(): Record<string, string> {
	return process.env.LD_LIBRARY_PATH === undefined ? {} : { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
}
export class Sandbox {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #directory: string;
	readonly #reader = new FrameReader();
	readonly #message: (message: SandboxMessage) => void;
	readonly #end: (reason: string) => void;
	readonly #exited: Promise<void>;
	#closed = false;
	#read = false;
	static async start(
		source: string,
		start: BridgeStart,
		onMessage: (message: SandboxMessage) => void,
		onEnd: (reason: string) => void,
	): Promise<Sandbox> {
		requireSandboxNode();
		if (Buffer.byteLength(source) > MAX_BUNDLE) throw new Error("terminal: the base bundle exceeds 8 MiB");
		// Node resolves the entry path before checking its exact filesystem permission.
		const dir = await realpath(await mkdtemp(join(tmpdir(), "objects-tui-")));
		await writeFile(join(dir, BOOTSTRAP_FILE), bootstrap);
		const sandbox = new Sandbox(dir, onMessage, onEnd);
		sandbox.#write(startFrame(start, source));
		return sandbox;
	}
	private constructor(dir: string, onMessage: (message: SandboxMessage) => void, onEnd: (reason: string) => void) {
		this.#directory = dir;
		this.#message = onMessage;
		this.#end = onEnd;
		this.#child = spawn(process.execPath, sandboxFlags(join(dir, BOOTSTRAP_FILE)), {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: dir,
			env: sandboxEnvironment(),
			windowsHide: true,
		});
		this.#exited = new Promise((resolve) => this.#child.once("close", resolve));
		this.#child.stderr.resume();
		this.#child.stdin.on("error", () => {});
		this.#child.on("error", (error) => this.#finish(`the terminal client failed: ${error.message}`));
		this.#child.on("close", () => {
			this.#finish("the terminal client exited");
			void rm(dir, { recursive: true, force: true });
		});
		this.#child.stdout.on("data", (chunk: Buffer) => {
			if (this.#closed) return;
			if (!this.#read) {
				this.#read = true;
				void rm(join(this.#directory, BOOTSTRAP_FILE), { force: true });
			}
			try {
				for (const message of this.#reader.push(chunk)) if (!this.#closed) this.#message(message);
			} catch (error) {
				this.#child.kill("SIGKILL");
				this.#finish(error instanceof Error ? error.message : String(error));
			}
		});
	}
	#finish(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#end(reason);
	}
	#write(bytes: Buffer): void {
		if (this.#child.stdin.writableLength + bytes.length > 64 * 1024 * 1024 + MAX_PIPE_FRAME) {
			this.#child.kill("SIGKILL");
			this.#finish("the terminal client stopped reading");
		} else this.#child.stdin.write(bytes);
	}
	post(message: LauncherMessage): void {
		if (!this.#closed) this.#write(launcherFrame(message));
	}
	async terminate(): Promise<void> {
		this.#closed = true;
		this.#child.kill("SIGKILL");
		await this.#exited;
	}
}

const bootstrap = `"use strict";
const originalProcess = process;
const call = Reflect.apply;
const stringSlice = String.prototype.slice;
const builtinModule = originalProcess.getBuiltinModule;
const load = name => call(builtinModule, originalProcess, [name]);
const define = Object.defineProperty, freeze = Object.freeze, create = Object.create;
const jsonRead = JSON.parse, jsonWrite = JSON.stringify;
const from = Buffer.from, alloc = Buffer.allocUnsafe, concat = Buffer.concat;
const copy = Buffer.prototype.copy, slice = Buffer.prototype.subarray, text = Buffer.prototype.toString;
const read32 = Buffer.prototype.readUInt32BE, write32 = Buffer.prototype.writeUInt32BE;
const Bytes = Uint8Array;
const Script = load('node:vm').Script, execute = Script.prototype.runInThisContext;
const input = originalProcess.stdin, output = originalProcess.stdout;
const write = output.write.bind(output), listen = input.on.bind(input);
const tick = originalProcess.nextTick, clock = originalProcess.hrtime, nanos = clock.bigint;
const uptime = originalProcess.uptime, exit = originalProcess.exit;
const end = code => call(exit, originalProcess, [code]);
const deny = () => { throw new Error("unavailable in the terminal's sandbox"); };
for (const module of [load('node:fs'), load('node:fs/promises')]) for (const key of Object.keys(module)) {
  if (typeof module[key] === 'function') define(module, key, {value:deny,enumerable:true,writable:false,configurable:false});
}
const v8 = load('node:v8');
for (const key of ['writeHeapSnapshot','getHeapSnapshot','queryObjects','setFlagsFromString','takeCoverage','startCpuProfile','startHeapProfile']) if (typeof v8[key] === 'function') v8[key] = deny;
load('node:module').syncBuiltinESMExports();
const emitter = load('node:events').EventEmitter.prototype;
for (const key of Object.getOwnPropertyNames(emitter)) if (key !== 'constructor' && typeof emitter[key] === 'function') define(originalProcess,key,{value:emitter[key],writable:false,configurable:false});
for (let parent = Object.getPrototypeOf(originalProcess); parent; parent = Object.getPrototypeOf(parent)) {
  for (const key of Reflect.ownKeys(parent)) define(parent,key,{configurable:false});
  Object.preventExtensions(parent);
}
const allowed = create(null);
for (const name of ${JSON.stringify(SANDBOX_BUILTINS)}) allowed[name] = true;
const requireAllowed = specifier => {
  if (typeof specifier !== 'string') return deny();
  const name = call(stringSlice,specifier,[0,5]) === 'node:' ? specifier.slice(5) : specifier;
  if (typeof name !== 'string' || allowed[name] !== true) throw new Error(specifier + ": unavailable in the terminal's sandbox");
  return load('node:' + name);
};
const limit = ${MAX_PIPE_FRAME};
function send(message) {
  let header = message, body;
  if (message.kind === 'write') {
    const value = String(message.data);
    if (value.length > limit) throw new RangeError("the terminal's bridge takes frames of at most 17 MiB");
    header = {kind:'write'}; body = from(value);
  } else if (message.kind === 'socket_send') {
    if (!(message.bytes instanceof Bytes)) throw new TypeError('socket_send: bytes expected');
    header = {kind:message.kind,socket:message.socket}; body = message.bytes;
  }
  const json = from(jsonWrite(header)), size = json.length + 4 + (body ? body.length : 0);
  if (size > limit) throw new RangeError("the terminal's bridge takes frames of at most 17 MiB");
  const prefix = alloc(8); call(write32,prefix,[size,0]); call(write32,prefix,[json.length,4]);
  write(concat(body ? [prefix,json,body] : [prefix,json]));
}
const fake = {
  arch:originalProcess.arch, platform:originalProcess.platform, version:originalProcess.version,
  versions:freeze({...originalProcess.versions}),release:freeze({...originalProcess.release}),
  env:freeze({}),argv:freeze(['node']),argv0:'node',execArgv:freeze([]),execPath:'node',title:'node',cwd:()=> '/',
  permission:originalProcess.permission,getBuiltinModule:requireAllowed,
  nextTick:(...args)=>call(tick,originalProcess,args),hrtime:Object.assign((...args)=>call(clock,originalProcess,args),{bigint:()=>call(nanos,originalProcess,[])}),
  uptime:()=>call(uptime,originalProcess,[]),exit:end,
  stdout:freeze({isTTY:false,write:data=>(send({kind:'write',data:String(data)}),true)}),stderr:freeze({isTTY:false,write:()=>true}),
  emit:()=>false,emitWarning:()=>{},listenerCount:()=>0,listeners:()=>[]
};
for (const key of ['on','once','off','addListener','removeListener','removeAllListeners']) fake[key] = function(){return fake;};
define(globalThis,'process',{value:freeze(fake),writable:false,configurable:false,enumerable:false});
for (const key of ['BroadcastChannel','localStorage','sessionStorage']) delete globalThis[key];
const evaluate = (source, filename) => {const options=create(null);options.filename=String(filename);return call(execute,new Script(String(source),options),[]);};
let callback, started = false, buffer = alloc(65536), offset = 0, used = 0;
function receive(payload) {
  const length = call(read32,payload,[0]), header = jsonRead(call(text,payload,['utf8',4,length+4])), body=call(slice,payload,[length+4]);
  if (!started) {
    started = true;
    globalThis.objectsBridge=freeze({start:freeze(header.start),send,onMessage:listener=>{callback=listener;},evaluate});
    try {const module={exports:{}};evaluate('(function(require,module,exports){'+call(text,body,['utf8'])+'\\n})','objects-base.js')(requireAllowed,module,module.exports);}
    catch(error){send({kind:'failed',message:String(error && error.message)});}
    return;
  }
  if (header.kind === 'input') header.data=call(text,body,['utf8']);
  else if (header.kind === 'socket_message' || header.kind === 'attached') header.bytes=new Bytes(body);
  if (callback) callback(header);
}
listen('data', chunk => {
  if (used+chunk.length>buffer.length) {
    const unread=used-offset, needed=unread+chunk.length, next=needed<=buffer.length?buffer:alloc(Math.max(needed,buffer.length*2));
    call(copy,buffer,[next,0,offset,used]);buffer=next;offset=0;used=unread;
  }
  call(copy,chunk,[buffer,used]);used+=chunk.length;
  while (used-offset>=4) {
    const length=call(read32,buffer,[offset]);if(length>limit) end(70);if(used-offset<length+4) break;
    const payload=alloc(length);call(copy,buffer,[payload,0,offset+4,offset+4+length]);offset+=length+4;receive(payload);
  }
  if (offset===used) offset=used=0;
});
listen('end',()=>end(0));
`;
