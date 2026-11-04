let clock = -1;
let serial: bigint | undefined;
const mask29 = (1n << 29n) - 1n;

export function uuidv7(): string {
	clock = Math.max(clock, Date.now());
	const random = crypto.getRandomValues(new Uint8Array(16));
	if (serial === undefined)
		serial = BigInt(`0x${Array.from(random.subarray(1, 6), (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
	else {
		if (serial === (1n << 41n) - 1n) throw new RangeError("UUIDv7 generator sequence exhausted");
		serial++;
	}
	const tail =
		BigInt(`0x${Array.from(random.subarray(11), (byte) => byte.toString(16).padStart(2, "0")).join("")}`) &
		((1n << 33n) - 1n);
	const id =
		(BigInt(clock) << 80n) | (7n << 76n) | ((serial >> 29n) << 64n) | (2n << 62n) | ((serial & mask29) << 33n) | tail;
	const hex = id.toString(16).padStart(32, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
