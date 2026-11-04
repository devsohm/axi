import { expect, it } from "vitest";
import { Connection } from "../src/connection.ts";

it.each(["é", "错", "😀"])(
	"decodes split startup diagnostics and includes them in the failure: %s",
	async (character) => {
		const output: string[] = [];
		const command = `
		const bytes = Buffer.from(${JSON.stringify(character)});
		process.stderr.write(bytes.subarray(0, 1));
		setTimeout(() => {
			process.stderr.end(bytes.subarray(1));
			process.exitCode = 7;
		}, 20);
	`;
		const connection = new Connection({
			command: [process.execPath, "-e", command],
			onLog: (text) => output.push(text),
		});
		try {
			await expect(connection.info()).rejects.toThrow(`remote stderr:\n${character}`);
			expect(output.join("")).toBe(character);
		} finally {
			connection.close();
		}
	},
);
