import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { createRegistry, GenerationTask, Harness, hook, hookTask, LiveDoc } from "../../src/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";
import { reviewTask } from "./after-run-review.ts";

const [directory, backend] = process.argv.slice(2);
if (!directory) throw new Error("Session directory is required");
process.on("disconnect", () => process.exit(0));
const models = createModels(),
	provider = fauxProvider(),
	registry = createRegistry();
const started = Promise.withResolvers<void>();
const Review = reviewTask(async () => {
	started.resolve();
	await new Promise(() => {});
});
models.setProvider(provider.provider);
provider.setResponses([fauxAssistantMessage("Answer saved before review")]);
registry.install({
	name: "review",
	tasks: [Review],
	hooks: [
		hook(GenerationTask, {
			afterRun: () => ({ tasks: [hookTask(Review, null)] }),
		}),
	],
});
const storage =
	backend === "jsonl"
		? await openNodeJsonlStorage(directory, context)
		: await openNodeSqliteStorage(join(directory, "session.sqlite"));
const harness = await Harness.open(
	storage,
	{ models, registry, settings: { compaction: { enabled: false } } },
	context,
);
const conversation = await harness.root(context, {
	agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } },
});
const submission = await conversation.submit(
	{ type: "input", content: "Save and review", requestId: "review-once" },
	context,
);
await submission.wait(context);
await started.promise;
const live = await harness.snapshot(LiveDoc, conversation.id, context);
process.send?.({
	kind: "ready",
	conversationId: conversation.id,
	submissionId: submission.id,
	tasks: live?.run?.afterRun?.tasks,
});
