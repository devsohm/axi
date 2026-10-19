import { type Static, Type } from "typebox";
import { getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";

const parameters = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});
export type WriteToolInput = Static<typeof parameters>;

export function createWriteTool() {
	return defineTool({
		name: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters,
		async execute({ path, content }, api, context) {
			const env = requireEnv(api);
			const absolute = await resolveToolPath(env, path, context);
			return withFileMutationQueue(
				env,
				absolute,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					getOrThrow(await env.writeFile(absolute, content, context));
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					return { output: [{ type: "text", text: `Successfully wrote to ${path}` }] };
				},
				context,
			);
		},
	});
}
