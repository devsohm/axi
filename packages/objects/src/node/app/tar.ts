export type TarEntry = { readonly path: string; readonly size: number; readonly data: AsyncIterable<Uint8Array> };
export type TarRead =
	| { readonly kind: "file"; readonly path: string; readonly size: number; readonly data: AsyncIterable<Uint8Array> }
	| { readonly kind: "directory"; readonly path: string };
const blockSize = 512;
function validPath(path: string): void {
	if (!path || /[\\\0]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))
		throw new Error(`tar: the path ${JSON.stringify(path)} is refused`);
}
function makeHeader(path: string, size: number): Uint8Array {
	validPath(path);
	const header = Buffer.alloc(blockSize),
		put = (at: number, length: number, value: string): void => {
			if (Buffer.byteLength(value) > length) throw new Error(`tar: ${value} does not fit ${length} bytes`);
			header.write(value, at, length, "utf8");
		};
	let prefix = "",
		name = path;
	if (Buffer.byteLength(path) > 100) {
		const slash = path.lastIndexOf("/");
		prefix = path.slice(0, slash);
		name = path.slice(slash + 1);
		if (slash < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100)
			throw new Error(`tar: the path ${path} is too long`);
	}
	put(0, 100, name);
	put(345, 155, prefix);
	put(100, 8, "0000644");
	put(108, 8, "0000000");
	put(116, 8, "0000000");
	put(124, 12, size.toString(8).padStart(11, "0"));
	put(
		136,
		12,
		Math.floor(Date.now() / 1000)
			.toString(8)
			.padStart(11, "0"),
	);
	header.fill(32, 148, 156);
	header[156] = 48;
	put(257, 8, "ustar\0" + "00");
	put(
		148,
		8,
		header
			.reduce((sum, byte) => sum + byte, 0)
			.toString(8)
			.padStart(6, "0") + "\0 ",
	);
	return header;
}
export async function* writeTar(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Uint8Array> {
	for await (const entry of entries) {
		yield makeHeader(entry.path, entry.size);
		let size = 0;
		for await (const chunk of entry.data) {
			size += chunk.length;
			if (size > entry.size) throw new Error(`tar: ${entry.path} is larger than its size ${entry.size}`);
			yield chunk;
		}
		if (size !== entry.size) throw new Error(`tar: ${entry.path} is ${size} bytes, not ${entry.size}`);
		const padding = (blockSize - (entry.size % blockSize)) % blockSize;
		if (padding) yield new Uint8Array(padding);
	}
	yield new Uint8Array(blockSize * 2);
}
class Reader {
	readonly #iterator: AsyncIterator<Uint8Array>;
	#chunk: Uint8Array = new Uint8Array();
	#offset = 0;
	constructor(source: AsyncIterable<Uint8Array>) {
		this.#iterator = source[Symbol.asyncIterator]();
	}
	async take(size: number): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		let length = 0;
		while (length < size) {
			if (this.#offset === this.#chunk.length) {
				const next = await this.#iterator.next();
				if (next.done) break;
				this.#chunk = next.value;
				this.#offset = 0;
			}
			const amount = Math.min(size - length, this.#chunk.length - this.#offset);
			parts.push(this.#chunk.subarray(this.#offset, this.#offset + amount));
			this.#offset += amount;
			length += amount;
		}
		return parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
	}
	async skip(size: number): Promise<void> {
		while (size > 0) {
			const bytes = await this.take(Math.min(size, 65536));
			if (!bytes.length) throw new Error("tar: the archive ends early");
			size -= bytes.length;
		}
	}
}
function field(header: Uint8Array, start: number, size: number): string {
	const bytes = header.subarray(start, start + size),
		end = bytes.indexOf(0);
	return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarRead> {
	const input = new Reader(source);
	for (;;) {
		const header = await input.take(blockSize);
		if (header.length !== blockSize) throw new Error("tar: the archive ends inside a header");
		if (header.every((byte) => !byte)) return;
		let checksum = 0;
		for (let i = 0; i < header.length; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
		if (parseInt(field(header, 148, 8).trim(), 8) !== checksum)
			throw new Error("tar: a header's checksum does not hold");
		const flag = String.fromCharCode(header[156]!);
		if (!["0", "\0", "5"].includes(flag))
			throw new Error(`tar: an entry of type ${JSON.stringify(flag)} is refused (files only)`);
		const prefix = field(header, 345, 155),
			path = ((prefix ? prefix + "/" : "") + field(header, 0, 100)).replace(/\/$/, "");
		validPath(path);
		const size = parseInt(field(header, 124, 12).trim() || "0", 8);
		if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tar: ${path} has no valid size`);
		if (flag === "5") {
			yield { kind: "directory", path };
			continue;
		}
		let remaining = size;
		const data = (async function* () {
			while (remaining) {
				const bytes = await input.take(Math.min(remaining, 65536));
				if (!bytes.length) throw new Error(`tar: the archive ends inside ${path}`);
				remaining -= bytes.length;
				yield bytes;
			}
		})();
		yield { kind: "file", path, size, data };
		await input.skip(remaining + ((blockSize - (size % blockSize)) % blockSize));
	}
}
