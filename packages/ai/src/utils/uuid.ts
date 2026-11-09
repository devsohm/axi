let ordinary = -1;
let counter: bigint | undefined;
export function uuidv7(timestampMs?: number): string {
	const time = timestampMs ?? Date.now();
	if (!Number.isInteger(time) || time < 0 || time > 0xffffffffffff)
		throw new RangeError("UUIDv7 timestamp must be an integer between 0 and 281474976710655");
	const timestamp = timestampMs === undefined ? (ordinary = Math.max(ordinary, time)) : timestampMs;
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	if (counter === undefined)
		counter =
			(BigInt(bytes[1]) << 32n) |
			(BigInt(bytes[2]) << 24n) |
			(BigInt(bytes[3]) << 16n) |
			(BigInt(bytes[4]) << 8n) |
			BigInt(bytes[5]);
	else {
		if (counter === (1n << 41n) - 1n) throw new RangeError("UUIDv7 generator sequence exhausted");
		counter++;
	}
	const encoded = BigInt(timestamp);
	for (let index = 5; index >= 0; index--) {
		bytes[index] = Number(encoded >> BigInt((5 - index) * 8)) & 255;
	}
	bytes[6] = 0x70 | Number((counter >> 37n) & 15n);
	bytes[7] = Number((counter >> 29n) & 255n);
	bytes[8] = 0x80 | Number((counter >> 23n) & 63n);
	bytes[9] = Number((counter >> 15n) & 255n);
	bytes[10] = Number((counter >> 7n) & 255n);
	bytes[11] = Number((counter & 127n) << 1n) | (bytes[11] & 1);
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
