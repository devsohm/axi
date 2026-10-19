import { type Static, Type } from "typebox";
import type { FileError } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";

const parameters = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({
				description:
					"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
			}),
			newText: Type.String({ description: "Replacement text for this targeted edit." }),
		}),
		{
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		},
	),
});
export type EditToolInput = Static<typeof parameters>;
export type EditToolDetails = { diff: string; patch: string; firstChangedLine?: number };

function singleEdit(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"oldText" in value &&
		typeof value.oldText === "string" &&
		"newText" in value &&
		typeof value.newText === "string"
	);
}
function prepareArguments(input: unknown): unknown {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
	const args: Record<string, unknown> = { ...input };
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
			else if (singleEdit(parsed)) args.edits = [parsed];
		} catch {}
	} else if (singleEdit(args.edits)) args.edits = [args.edits];
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		args.edits = [...(Array.isArray(args.edits) ? args.edits : []), { oldText: args.oldText, newText: args.newText }];
		delete args.oldText;
		delete args.newText;
	}
	return args;
}

export function createEditTool() {
	return defineTool<typeof parameters, EditToolDetails>({
		name: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters,
		prepareArguments: (input) => prepareArguments(input) as EditToolInput,
		async execute({ path, edits }, api, context) {
			if (!Array.isArray(edits) || edits.length === 0)
				throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
			const env = requireEnv(api);
			const absolute = await resolveToolPath(env, path, context);
			const accessError = (error: FileError) =>
				new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
			const check = () => {
				if (context.abortSignal?.aborted) throw new Error("Operation aborted");
			};
			return withFileMutationQueue(
				env,
				absolute,
				async () => {
					check();
					const info = await env.fileInfo(absolute, context);
					if (!info.ok) throw accessError(info.error);
					if (info.value.kind !== "file" && info.value.kind !== "symlink")
						throw new Error(`Could not edit file: ${path}. Path is not a file.`);
					const read = await env.readTextFile(absolute, context);
					if (!read.ok) throw accessError(read.error);
					check();
					const { bom, text } = stripBom(read.value);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizeToLF(text), edits, path);
					check();
					const written = await env.writeFile(
						absolute,
						bom + restoreLineEndings(newContent, detectLineEnding(text)),
						context,
					);
					if (!written.ok) throw accessError(written.error);
					check();
					const { diff, firstChangedLine } = generateDiffString(baseContent, newContent);
					return {
						output: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
						details: {
							diff,
							patch: generateUnifiedPatch(path, baseContent, newContent),
							...(firstChangedLine === undefined ? {} : { firstChangedLine }),
						},
					};
				},
				context,
			);
		},
	});
}
