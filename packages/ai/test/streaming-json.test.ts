import { expect, test } from "vitest";
import { StreamingJsonParser, ToolCallArgumentsStream } from "../src/utils/streaming-json.ts";

test("keeps earlier argument previews immutable and emits only the new string suffix", () => {
	const parser = new StreamingJsonParser();
	expect(parser.append('{"file":"main.ts","text":"a')).toEqual([
		{ kind: "set", path: [], value: {} },
		{ kind: "set", path: ["file"], value: "main.ts" },
		{ kind: "set", path: ["text"], value: "a" },
	]);
	const first = parser.snapshot();
	expect(parser.append('b\\u00')).toEqual([{ kind: "append", path: ["text"], text: "b" }]);
	expect(parser.append('e9"}')).toEqual([{ kind: "append", path: ["text"], text: "é" }]);
	expect(parser.snapshot()).toEqual({ file: "main.ts", text: "abé" });
	expect(first).toEqual({ file: "main.ts", text: "a" });
});

test("replaces complete provider arguments and diagnoses an unfinished object only at completion", () => {
	const stream = new ToolCallArgumentsStream();
	expect(stream.append('{"n":1e')).toEqual({ n: 1 });
	expect(stream.finish().argumentsError).toBeTypeOf("string");
	expect(stream.replace('{"n":1e2}')).toEqual({ delta: '2}', arguments: { n: 100 } });
	expect(stream.replace('{"other":true}')).toEqual({ delta: undefined, arguments: { other: true } });
	expect(stream.finish()).toEqual({ arguments: { other: true } });
});
