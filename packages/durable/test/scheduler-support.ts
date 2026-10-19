import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { MemoryStorage } from "../src/index.ts";
import { resolveSettings } from "../src/harness/agent.ts";
import { TaskScheduler, type TaskSchedulerOptions } from "../src/harness/scheduler.ts";
import type { Agent, AnyTask, HarnessSettings, RegistryReader, RegistrySnapshot } from "../src/harness/types.ts";
import { settleSchedulerOutcome } from "../src/harness/live.ts";
import { withdrawQueuedInputs } from "../src/harness/inbox.ts";
import { SessionImpl } from "../src/session/session.ts";
import { hostTimers } from "../src/timers.ts";
import type { ConversationId, ReportInfo, Storage } from "../src/types.ts";
export class Definitions implements RegistryReader {
	#snapshot: RegistrySnapshot;
	readonly #listeners = new Set<() => void>();
	constructor(tasks: readonly AnyTask[]) {
		this.#snapshot = this.#make(tasks);
	}
	#make(tasks: readonly AnyTask[]): RegistrySnapshot {
		const extension = { name: "tasks", tasks };
		return {
			installed: () => [extension],
			extension: (name) => (name === "tasks" ? extension : undefined),
			tools: () => [],
			sections: () => [],
			tasks: () => tasks,
			task: (name) => tasks.find((task) => task.definition.name === name),
		};
	}
	snapshot(): RegistrySnapshot {
		return this.#snapshot;
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	replace(tasks: readonly AnyTask[]): void {
		this.#snapshot = this.#make(tasks);
		for (const listener of [...this.#listeners]) listener();
	}
}
export class ScheduledSession extends SessionImpl {
	#scheduler: TaskScheduler | undefined;
	attach(options: Omit<TaskSchedulerOptions, "session" | "storage" | "writeAtClose">): TaskScheduler {
		const scheduler = new TaskScheduler({
			...options,
			session: this,
			storage: this.storage,
			writeAtClose: (writes) => this.writeAtClose(writes),
		});
		this.#scheduler = scheduler;
		return scheduler;
	}
	protected override beforeClose(): Promise<void> {
		return this.#scheduler?.join() ?? Promise.resolve();
	}
}

const sessions: ScheduledSession[] = [];
export async function closeSchedulers(): Promise<void> {
	for (const session of sessions.splice(0)) await session.close(context);
}
export const agent: Agent = {
	thinkingLevel: "off",
	extensions: [],
	tools: [],
	callable: [],
	deferred: [],
	sections: [],
};
export async function open(
	tasks: readonly AnyTask[],
	options: {
		storage?: Storage;
		now?: () => number;
		settings?: HarnessSettings;
		agent?: TaskSchedulerOptions["agent"];
	} = {},
) {
	const storage = options.storage ?? new MemoryStorage(),
		now = options.now ?? Date.now;
	const session = new ScheduledSession(storage, now);
	sessions.push(session);
	const models = createModels();
	const registry = new Definitions(tasks),
		reports: { error: unknown; info: ReportInfo }[] = [];
	const scheduler = session.attach({
		registry,
		models: () => models,
		agent: options.agent ?? (async () => agent),
		settings: () => resolveSettings(options.settings),
		env: async () => undefined,
		now,
		onWake: () => {},
		timers: hostTimers(undefined, (error) => {
			throw error;
		}),
		report: (error, info) => reports.push({ error, info }),
		settleOutcome: settleSchedulerOutcome,
		withdrawInputs: withdrawQueuedInputs,
		conversation: async () => undefined,
		context,
	});
	await scheduler.open(context);
	return { session, storage, scheduler, registry, reports };
}
export async function root(session: ScheduledSession): Promise<ConversationId> {
	return (await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context)).id;
}
