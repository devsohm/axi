import type { ImageContent, TextContent } from "@axi/ai";
import type { CodemodeOutputItem, CodemodeResult } from "@axi/codemode/portable";

type Item = TextContent | ImageContent;
type Limits = { readonly maxBytes: number; readonly maxLines: number };
export type OutputFile = (name: string, data: string | Uint8Array) => Promise<{ path: string } | { error: string }>;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

function layout(output: readonly CodemodeOutputItem[]): Item[] {
	const count = output.filter((item) => item.type === "text" && !item.console).length;
	const items: Item[] = [];
	const logs: string[] = [];
	let index = 0;
	for (const item of output) {
		if (item.type === "image") items.push(item);
		else if (item.console) logs.push(item.text);
		else items.push({ type: "text", text: count > 1 ? `==> text ${++index}/${count} <==\n${item.text}` : item.text });
	}
	if (logs.length) items.push({ type: "text", text: `<console_output>\n${logs.join("\n")}\n</console_output>` });
	return items;
}

function mergeText(items: readonly Item[]): Item[] {
	const output: Item[] = [];
	let text: string[] = [];
	let last = "";
	const flush = () => {
		if (text.length) output.push({ type: "text", text: text.join("") });
		text = [];
		last = "";
	};
	for (const item of items) {
		if (item.type === "image") {
			flush();
			output.push(item);
			continue;
		}
		if (last && !last.endsWith("\n")) {
			text.push("\n");
			last = "\n";
		}
		text.push(item.text);
		if (item.text !== "") last = item.text;
	}
	flush();
	return output;
}

async function bound(
	items: Item[],
	maxTokens: number,
	limits: Limits,
	write: OutputFile,
): Promise<{ items: Item[]; fullOutputPath?: string }> {
	const texts = items.flatMap((item) => (item.type === "text" ? [item.text] : []));
	const combined = texts.join("\n");
	const chars = Math.min(maxTokens * 4, Math.floor(limits.maxBytes / 4));
	const halfLines = Math.floor((limits.maxLines - 100) / 2);
	if (!texts.length || (combined.length <= chars && combined.split("\n").length <= halfLines * 2)) return { items };
	const headChars = Math.floor(chars / 2);
	const tailChars = chars - headChars;
	const head = combined.slice(0, headChars).split("\n").slice(0, halfLines).join("\n");
	const tail = tailChars ? combined.slice(-tailChars).split("\n").slice(-halfLines).join("\n") : "";
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / 4)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil((combined.length - head.length - tail.length) / 4)} tokens truncated…${tail}`;
	const saved = await write("output.txt", combined);
	text +=
		"path" in saved
			? `\n\n[Full output: ${saved.path} (read with offset/limit)]`
			: `\n\n[Could not save the full output: ${saved.error}]`;
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...("path" in saved ? { fullOutputPath: saved.path } : {}),
	};
}

async function imageFiles(items: Item[], write: OutputFile): Promise<Item[]> {
	const names = new Map<string, Promise<string>>();
	const extensions: Record<string, string> = {
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/gif": ".gif",
		"image/webp": ".webp",
	};
	const save = async (image: ImageContent, index: number): Promise<string> => {
		const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
		const result = await write(`image-${index}${extensions[image.mimeType] ?? ".bin"}`, bytes);
		const kind = `${image.mimeType}, ${bytes.length} bytes`;
		return "path" in result
			? `[Image saved to ${result.path} (${kind})]`
			: `[Image (${kind}) could not be saved: ${result.error}]`;
	};
	return (
		await Promise.all(
			items.map(async (item): Promise<Item[]> => {
				if (item.type === "text") return [item];
				let label = names.get(item.data);
				if (!label) {
					label = save(item, names.size + 1);
					names.set(item.data, label);
				}
				return [{ type: "text", text: await label }, item];
			}),
		)
	).flat();
}

function errorText(
	result: Extract<CodemodeResult, { ok: false }>,
	calls: readonly { name: string; status: string }[],
): string {
	const { error } = result;
	const message =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: `${error.kind === "timeout" ? "Script timed out" : error.kind === "aborted" ? "Script aborted" : "Script sandbox failed"}: ${error.message}`;
	return `${message}\n\n${calls.length ? `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}` : "No tool calls were made."}`;
}

export async function formatResult(
	result: CodemodeResult,
	options: {
		readonly generatedImages: number;
		readonly wallMs: number;
		readonly maxOutputTokens: number;
		readonly calls: readonly { name: string; status: string }[];
		readonly limits: Limits;
		readonly write: OutputFile;
	},
): Promise<{ content: Item[]; fullOutputPath?: string }> {
	const output = [...result.output];
	if (result.ok && result.value !== undefined)
		output.push({
			type: "text",
			text: typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? String(result.value)),
		});
	const items = layout(output);
	if (!result.ok) items.push({ type: "text", text: `Script error:\n${errorText(result, options.calls)}` });
	if (options.generatedImages > 0 && !items.some((item) => item.type === "image"))
		items.push({
			type: "text",
			text: `Note: models.generateImages() returned ${options.generatedImages} image${options.generatedImages === 1 ? "" : "s"} that the script did not show. Show each image block of result.output with image(block).`,
		});
	const bounded = await bound(mergeText(items), options.maxOutputTokens, options.limits, options.write);
	return {
		content: [
			{
				type: "text",
				text: `${result.ok ? "Script completed" : "Script failed"}\nWall time ${(options.wallMs / 1000).toFixed(1)} seconds\nOutput:\n`,
			},
			...mergeText(await imageFiles(bounded.items, options.write)),
		],
		...(bounded.fullOutputPath === undefined ? {} : { fullOutputPath: bounded.fullOutputPath }),
	};
}
