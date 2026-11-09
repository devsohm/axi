import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, it } from "vitest";
import { resolveSettings } from "../src/harness/agent.ts";
import { compactionPolicy } from "../src/harness/compaction.ts";
import { AgentDoc, createRegistry, defineTask, Harness, UserEntry, type CompactionSettings } from "../src/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

it("resolves conversation and model compaction fields independently", () => {
	const settings = resolveSettings({
		compaction: {
			enabled: true,
			reserveTokens: 120,
			keepRecentTokens: 240,
			backgroundTokens: 360,
			modelOverrides: { "local/small": { reserveTokens: 20, keepRecentTokens: 40, enabled: true } },
		},
	});
	const conversation: CompactionSettings = {
		enabled: false,
		reserveTokens: 60,
		keepRecentTokens: 80,
		modelOverrides: { "local/small": { keepRecentTokens: 10 } },
	};
	expect(compactionPolicy(settings, { provider: "local", modelId: "small" }, conversation)).toEqual({
		enabled: false,
		reserveTokens: 20,
		keepRecentTokens: 10,
		backgroundTokens: 360,
	});
	expect(compactionPolicy(settings, { provider: "local", modelId: "large" }, conversation)).toEqual({
		enabled: false,
		reserveTokens: 60,
		keepRecentTokens: 80,
		backgroundTokens: 360,
	});
	expect(
		compactionPolicy(
			settings,
			{ provider: "local", modelId: "small" },
			{
				...conversation,
				modelOverrides: { "local/small": { enabled: true, reserveTokens: 0 } },
			},
		),
	).toEqual({ enabled: true, reserveTokens: 0, keepRecentTokens: 40, backgroundTokens: 360 });
});

it("persists, forks, replaces and clears validated conversation compaction settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-compaction-settings-"));
	const options = { models: createModels(), registry: createRegistry(), onWake: () => {} };
	const owner = defineTask<null, { phase: "hold" }, null>({
		name: "hold",
		version: 1,
		initial: () => ({ phase: "hold" }),
		phases: { hold: async () => {} },
		abort: async () => {},
	});
	options.registry.install({ name: "owner", tasks: [owner] });
	const storage = () => openNodeSqliteStorage(join(directory, "session.sqlite"));
	let harness = await Harness.open(await storage(), options, context);
	try {
		const compaction: CompactionSettings = {
			reserveTokens: 0,
			enabled: undefined,
			modelOverrides: { "local/small": { keepRecentTokens: 25, backgroundTokens: undefined } },
		};
		const expected = { reserveTokens: 0, modelOverrides: { "local/small": { keepRecentTokens: 25 } } };
		const root = await harness.root(context, { agent: { compaction } });
		compaction.modelOverrides!["local/small"]!.keepRecentTokens = 99;
		expect((await root.agent(context)).compaction).toEqual(expected);
		const entry = await root.commit(
			(tx) =>
				tx.appendEntry(UserEntry, root.id, {
					model: [{ role: "user", content: "Saved configuration", timestamp: 1 }],
				}),
			context,
		);
		const fork = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
		const childId = await root.commit(async (tx) => {
			const taskId = await tx.createTask(owner, null, { ownership: { kind: "conversation" } });
			return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
		}, context);
		expect((await (await harness.conversation(childId, context))!.agent(context)).compaction).toEqual(expected);
		await root.configure({ compaction: { enabled: false } }, context);
		await root.configure({ compaction: undefined }, context);
		expect((await root.agent(context)).compaction).toEqual({ enabled: false });
		for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(
				root.configure({ compaction: { modelOverrides: { "local/small": { reserveTokens: value } } } }, context),
			).rejects.toThrow(RangeError);
		}
		expect((await harness.snapshot(AgentDoc, root.id, context))?.compaction).toEqual({ enabled: false });
		await harness.close(context);
		harness = await Harness.open(await storage(), options, context);
		const restored = await harness.conversation(fork.id, context);
		expect((await restored!.agent(context)).compaction).toEqual(expected);
		await restored!.configure({ compaction: null }, context);
		expect((await restored!.agent(context)).compaction).toBeUndefined();
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
