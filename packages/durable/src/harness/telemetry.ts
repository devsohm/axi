import { defineTelemetrySchema } from "@axi/telemetry";

const entry = {
	description: "Committed transcript entry metadata.",
	attributes: {
		"entry.id": { type: "number", required: true, description: "Entry ID.", cardinality: "high" },
		"entry.kind": { type: "string", required: true, description: "Entry kind." },
	},
} as const;
const reportFields = {
	type: {
		type: "string",
		required: true,
		description: "Report category.",
		values: [
			"session_failed",
			"task_faulted",
			"task_parked",
			"migration_failed",
			"task_outdated",
			"task_error",
			"extension_error",
			"host_error",
			"listener_error",
		],
	},
	reason: {
		type: "string",
		required: false,
		description: "Fixed reason code.",
		values: ["threw", "restart_limit", "missing_task", "incompatible_task"],
	},
	extension: { type: "string", required: false, description: "Registered extension." },
	"task.id": { type: "number", required: false, description: "Task ID.", cardinality: "high" },
} as const;
const report = { description: "Report category without its error payload.", attributes: reportFields } as const;
const submission = {
	description: "Settled submission metadata.",
	attributes: {
		"submission.id": { type: "number", required: true, description: "Submission ID.", cardinality: "high" },
		status: { type: "string", required: true, values: ["done", "unanswered"], description: "Settlement state." },
		"answer.entry_id": { type: "number", required: false, description: "Answer ID.", cardinality: "high" },
	},
} as const;
export const DURABLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"axi.durable.submit": {
			description:
				"Public submission admission through its commit. Input traces link to callers; writes are caller children.",
			parents: { kind: "any" },
			startAttributes: {
				"submission.type": {
					type: "string",
					required: true,
					values: ["input", "write"],
					description: "Submission kind.",
				},
				"conversation.id": { type: "number", required: true, description: "Conversation ID.", cardinality: "high" },
			},
			endAttributes: {
				"submission.id": { type: "number", description: "Admitted ID.", cardinality: "high" },
				result: {
					type: "string",
					values: ["queued", "placed", "done"],
					description: "Admission result, with stale writes settled as done.",
				},
			},
			events: { "axi.durable.entry": entry, "axi.durable.submission": submission, "axi.durable.report": report },
			status: { default: "ok", errorWhen: "Admission fails." },
		},
		"axi.durable.phase": {
			description: "Task phase handler and decision commit, excluding waiting and restart time.",
			parents: { kind: "any" },
			startAttributes: {
				"task.id": { type: "number", required: true, description: "Task ID.", cardinality: "high" },
				"task.name": { type: "string", required: true, description: "Registered task." },
				phase: { type: "string", required: true, description: "Invoked phase." },
				kind: { type: "string", required: true, values: ["run", "abort"], description: "Invocation kind." },
				attempt: { type: "number", required: false, description: "Checkpoint attempt." },
				resumed: { type: "boolean", required: true, description: "First invocation after loading a stored task." },
			},
			endAttributes: {
				outcome: { type: "string", description: "Next phase, durable wait, done, faulted, or aborted." },
				"tool.name": { type: "string", description: "Called tool." },
				"tool.call_id": { type: "string", description: "Transcript call ID.", cardinality: "high" },
			},
			events: {
				"axi.durable.entry": entry,
				"axi.durable.submission": submission,
				"axi.durable.report": report,
				"axi.durable.checkpoint": {
					description: "Committed phase change during a running invocation.",
					attributes: { phase: { type: "string", required: true, description: "Committed phase." } },
				},
				"axi.durable.replay": {
					description: "Nested call answered by its stored result.",
					attributes: { "tool.name": { type: "string", required: true, description: "Called tool." } },
				},
			},
			status: {
				default: "ok",
				errorWhen:
					"Faulted, failed, or orphaned task: fixed category and diagnostic limited to 500 characters. Aborts stay ok.",
			},
		},
	},
	metrics: {
		"axi.durable.reports": {
			kind: "counter",
			description: "Reports by category.",
			attributes: { type: reportFields.type },
		},
		"axi.durable.phase.duration": {
			kind: "histogram",
			unit: "ms",
			description: "Handler and decision commit duration.",
			attributes: {
				task: { type: "string", required: true, description: "Registered task." },
				phase: { type: "string", required: true, description: "Invoked phase." },
				outcome: { type: "string", required: true, description: "Phase outcome." },
			},
		},
		"axi.durable.tasks.active": {
			kind: "upDownCounter",
			description: "Live tasks, released on settlement or close.",
			attributes: { task: { type: "string", required: true, description: "Registered task." } },
		},
	},
});
