import { type Context, copyJson, type JsonRepresentation } from "@axi/chord";
import { withTelemetry } from "@axi/chord/context";
import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	type TelemetrySpan,
} from "@axi/telemetry";
import { ConversationBusy } from "../errors.ts";
import type { SessionImpl } from "../session/session.ts";
import type { ConversationId, JsonObject, Storage, SubmissionId, SubmissionRecord, Tx } from "../types.ts";
import { startRun } from "./generation.ts";
import {
	appendInput,
	applyBoundary,
	hasQueuedReset,
	InboxDoc,
	isDisplayOnly,
	isStale,
	pickInputEntry,
	prepareBoundary,
	type QueueModes,
	removeInboxItem,
} from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { DURABLE_TELEMETRY_SCHEMA } from "./telemetry.ts";
import type { SettledSubmissionRecord, Submission, SubmissionDraft, UserInput } from "./types.ts";
import { closedError, Waiters } from "./util.ts";

type AbortResult = "aborted" | "already_placed" | "settled";
type Admission = { readonly id: SubmissionId; readonly status: "queued" | "placed" | "done" };
const settled = (record: SubmissionRecord): record is SettledSubmissionRecord =>
	record.status === "done" || record.status === "unanswered";
export class Submissions {
	readonly #telemetry: TelemetryContext;
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #now: () => number;
	readonly #modes: () => QueueModes;
	readonly #resume: () => void;
	readonly #waiters = new Waiters<SubmissionId, SettledSubmissionRecord>();
	#closed = false;
	constructor(
		session: SessionImpl,
		storage: Storage,
		now: () => number,
		queueModes: () => QueueModes,
		resume: () => void,
		telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
	) {
		this.#telemetry = telemetry;
		this.#session = session;
		this.#storage = storage;
		this.#now = now;
		this.#modes = queueModes;
		this.#resume = resume;
		session.observeCommits((publication) => {
			for (const change of publication.changes)
				if (change.type === "submission" && settled(change.value)) this.#waiters.resolve(change.value.id, change.value);
		});
		session.subscribeClose(() => {
			this.#closed = true;
			this.#waiters.rejectAll(closedError(session));
		});
	}
	async submit(id: ConversationId, draft: SubmissionDraft, context: Context): Promise<Submission> {
		this.#resume();
		const parent = draft.type === "input" ? this.#telemetry : context.telemetry;
		return createTypedSpanStarter(parent, [DURABLE_TELEMETRY_SCHEMA])(
			"axi.durable.submit",
			{
				"submission.type": draft.type,
				"conversation.id": id,
			},
			async (span) => {
				if (draft.type === "input") span.addLink({ context: context.telemetry });
				try {
					const admitted = await this.#session.commitWith(
						(tx) => admitSubmission(tx, id, draft, this.#now(), this.#modes(), span),
						withTelemetry(span, context),
					);
					span.setAttributes({ "submission.id": admitted.id, result: admitted.status });
					return this.#handle(admitted.id);
				} catch (error) {
					span.setStatus({ status: "error" });
					throw error;
				}
			},
		);
	}
	async get(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		return (await this.#session.readOnLine(() => this.#storage.submission(id, context))) === undefined
			? undefined
			: this.#handle(id);
	}
	async status(id: SubmissionId, context: Context): Promise<SubmissionRecord> {
		const record = await this.#session.readOnLine(() => this.#storage.submission(id, context));
		if (record === undefined) throw new Error(`Submission ${id} does not exist`);
		return record;
	}
	async wait(id: SubmissionId, context: Context): Promise<SettledSubmissionRecord> {
		this.#resume();
		const result = await this.#session.readOnLine(async () => {
			const record = await this.#storage.submission(id, context);
			if (record === undefined) throw new Error(`Submission ${id} does not exist`);
			if (settled(record)) return { promise: Promise.resolve(record) };
			if (this.#closed) throw closedError(this.#session);
			return { promise: this.#waiters.add(id, context) };
		});
		return result.promise;
	}
	abort(id: SubmissionId, context: Context, conversationId?: ConversationId): Promise<AbortResult | "not_found"> {
		return this.#session.commitWith(async (tx) => {
			const record = await tx.submission(id);
			if (record === undefined || (conversationId !== undefined && record.conversationId !== conversationId))
				return "not_found";
			if (record.status !== "queued") return record.status === "placed" ? "already_placed" : "settled";
			tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
			await removeInboxItem(tx, record.conversationId, id);
			return "aborted";
		}, context);
	}
	#handle(id: SubmissionId): Submission {
		return {
			id,
			status: (context) => this.status(id, context),
			wait: (context) => this.wait(id, context),
			abort: async (context) => {
				const result = await this.abort(id, context);
				if (result === "not_found") throw new Error(`Submission ${id} does not exist`);
				return result;
			},
		};
	}
}

export async function admitSubmission(
	tx: Tx,
	id: ConversationId,
	draft: SubmissionDraft,
	now: number,
	modes: QueueModes,
	span?: TelemetrySpan,
): Promise<Admission> {
	if (draft.type === "input" && draft.entry !== undefined) {
		const kind = draft.entry.kind;
		if (typeof kind !== "string" || kind.length === 0 || kind.startsWith("axi."))
			throw new TypeError(
				`An input entry's kind must be a non-empty string not starting with "axi.", got ${String(kind)}`,
			);
	}
	if (draft.requestId !== undefined) {
		const existing = await tx.submissionByRequest(id, draft.requestId);
		if (existing !== undefined) {
			if (existing.type !== draft.type)
				throw new Error(`Request ${draft.requestId} already identifies a submission of type ${existing.type}`);
			return { id: existing.id, status: existing.status === "unanswered" ? "done" : existing.status };
		}
	}
	const fields = { conversationId: id, requestId: draft.requestId, trace: span?.propagation?.inject(span) };
	if (draft.type === "write" && isDisplayOnly(draft.entry) && !hasQueuedReset((await tx.doc(InboxDoc, id)).items)) {
		const entry = await tx.appendEntry(id, draft.entry);
		return {
			id: (await tx.createSubmission({ ...fields, type: "write", status: "done", entry: entry.id })).id,
			status: "done",
		};
	}
	const live = await tx.doc(LiveDoc, id),
		busy = live.run !== undefined;
	if (
		draft.type === "input" &&
		draft.whenBusy === "steer" &&
		live.run !== undefined &&
		span?.propagation !== undefined
	) {
		const run = await tx.task(live.run.taskId);
		if (run?.trace !== undefined) span.addLink({ context: span.propagation.extract(run.trace) });
	}
	if (busy && draft.type === "input" && draft.whenBusy === "reject") throw new ConversationBusy(id);
	const boundary = busy ? undefined : await prepareBoundary(tx, id, modes);
	if (boundary === undefined || boundary.inbox.items.length > 0) {
		const submission = await tx.createSubmission({
			...fields,
			type: draft.type,
			status: "queued",
		});
		const value = copyJson(draft.type === "write" ? draft.entry : draft.content, { omitUndefinedProperties: true }),
			items = (boundary?.inbox ?? (await tx.doc(InboxDoc, id))).items;
		if (draft.type === "write") items.push({ id: submission.id, mode: "write", entry: value as JsonObject });
		else
			items.push({
				id: submission.id,
				mode: draft.whenBusy === "steer" ? "steer" : "followUp",
				content: value as JsonRepresentation<UserInput>,
				...(draft.entry === undefined ? {} : { entry: pickInputEntry(draft.entry) }),
			});
		if (boundary !== undefined) {
			const { users } = await applyBoundary(tx, boundary, "final", now);
			if (users.length) await startRun(tx, id, live, users);
			return {
				id: submission.id,
				status: draft.type === "write" ? "done" : users.at(-1) === submission.id ? "placed" : "queued",
			};
		}
		return { id: submission.id, status: "queued" };
	}
	if (draft.type === "write") {
		if (isStale(boundary, draft.entry))
			return {
				id: (
					await tx.createSubmission({
						...fields,
						type: "write",
						status: "unanswered",
						reason: "stale",
					})
				).id,
				status: "done",
			};
		const entry = await tx.appendEntry(id, draft.entry);
		return {
			id: (await tx.createSubmission({ ...fields, type: "write", status: "done", entry: entry.id })).id,
			status: "done",
		};
	}
	const entry = await appendInput(tx, id, draft.content, draft.entry, now);
	const submission = await tx.createSubmission({
		...fields,
		type: "input",
		status: "placed",
		entry: entry.id,
	});
	await startRun(tx, id, live, [submission.id]);
	return { id: submission.id, status: "placed" };
}
