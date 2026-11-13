import { expect, test } from "vitest";
import { readTar, writeTar } from "../src/node/app/tar.ts";

test.each(["complete", "stop", "invalid"] as const)(
	"tar reading closes its input after %s consumption",
	async (mode) => {
		const chunks: Uint8Array[] = [];
		for await (const chunk of writeTar([
			{
				path: "saved.txt",
				size: 3,
				data: (async function* () {
					yield Buffer.from("abc");
				})(),
			},
		]))
			chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		if (mode === "invalid") bytes[0] = 0;
		let closed = false;
		async function* source() {
			try {
				yield bytes;
			} finally {
				closed = true;
			}
		}
		const names: string[] = [];
		async function consume() {
			for await (const entry of readTar(source())) {
				names.push(entry.path);
				if (mode === "stop") break;
			}
		}
		if (mode === "invalid") await expect(consume()).rejects.toThrow(/checksum/);
		else {
			await consume();
			expect(names).toEqual(["saved.txt"]);
		}
		expect(closed).toBe(true);
	},
);
