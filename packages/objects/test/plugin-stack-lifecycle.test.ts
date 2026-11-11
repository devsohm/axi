import { expect, test } from "vitest";
import { mapStack, registerScript } from "../src/node/plugins/stack.ts";

test("registration leaves source-map decoding until a matching stack needs it", () => {
	const file = "lazy-map-plugin.js";
	const source = "//# sourceMappingURL=data:application/json;base64," + Buffer.from("{bad json").toString("base64");
	const owner = {};
	expect(() => registerScript(file, source, "/plugins/lazy", owner)).not.toThrow();
	const unrelated = new Error("unrelated");
	unrelated.stack = "at another.js:1:1";
	expect(mapStack(unrelated)).toBe(unrelated.stack);
	const matching = new Error("matching");
	matching.stack = `at ${file}:1:1`;
	expect(() => mapStack(matching)).toThrow(SyntaxError);
});
