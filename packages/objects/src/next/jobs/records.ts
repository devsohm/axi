import { withoutAbortSignal, type Context } from "../../context/index.ts";
import type { Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import { ObjectsError } from "../data/index.ts";
import { check, validatorFor } from "../data/internal.ts";
import { Persistence, type Documents, type Staged, type Transaction } from "../documents/internal.ts";
import type { JsonObject } from "../documents/index.ts";
import type { HostError } from "../host/report.ts";
import { uuidv7 } from "../host/uuid.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ObjectsStore } from "../store/store.ts";
import type { JobDefinition, JobError } from "./definition.ts";
import type { StartOptions } from "./job.ts";
import { PersistedRuns, type LoadedRecord } from "./persisted.ts";
import { JobRun, type AnyOutcome, type BlockedReason, type Phase, type Run } from "./run.ts";
import { RunStates } from "./run-states.ts";
import { Running } from "./running.ts";
import { outcomeOf, storedRun, type StoredFields } from "./stored.ts";

export type RecordsOwner = {
	readonly label: string;
	readonly host: { report(error: HostError): void };
	readonly context: Context;
	readonly documents: Documents;
	readonly store: { readonly store: ObjectsStore; readonly owner: string } | undefined;
	countRuns(delta: number): void;
	held(deadline: number): void;
};
export type Settled =
	| { readonly kind: "done"; readonly result: unknown }
	| { readonly kind: "failed"; readonly error: JobError };
type Fields = {
	readonly phase?: Phase;
	readonly restarts?: number;
	readonly finishFailures?: number;
	readonly abortMarked?: true;
};
type RecordChange =
	| { readonly kind: "create"; readonly run: JobRun }
	| { readonly kind: "delete"; readonly run: JobRun }
	| { readonly kind: "drop"; readonly run: JobRun }
	| { readonly kind: "unblock"; readonly run: JobRun; readonly phase: Phase }
	| { readonly kind: "update"; readonly run: JobRun; readonly fields: Fields }
	| {
			readonly kind: "outcome";
			readonly run: JobRun;
			readonly outcome: AnyOutcome;
	  }
	| {
			readonly kind: "block";
			readonly run: JobRun;
			readonly reason: BlockedReason;
	  };
type Adoption = RecordChange | { readonly kind: "restore"; readonly run: JobRun };
type Restored = {
	readonly run: JobRun;
	readonly change: RecordChange | undefined;
};
type AttachedJob = { invoke(run: JobRun): void; finish(run: JobRun): void };
export type Staging = Staged & {
	readonly started: JobRun[];
	readonly changes: Adoption[];
	readonly adopts: (() => void)[];
	finishing: JobRun | undefined;
};
const interrupted: Settled = {
	kind: "failed",
	error: { kind: "aborted", reason: "restart" },
};
const aborted: Settled = {
	kind: "failed",
	error: { kind: "aborted", reason: "abort" },
};

export class JobRecords {
	definition: JobDefinition<unknown, unknown, unknown>;
	readonly running: Running;
	readonly #owner: RecordsOwner;
	#states: RunStates | undefined;
	#declared = true;
	readonly #persisted: PersistedRuns | undefined;
	readonly #runs = new Map<string, JobRun>();
	readonly #keys = new Map<string, JobRun>();
	readonly #waiting = new Set<JobRun>();
	readonly #stopped = new Set<JobRun>();
	#active = 0;
	#loaded = false;
	#job: AttachedJob | undefined;
	#ended: ObjectsError | undefined;
	constructor(definition: JobDefinition<unknown, unknown, unknown>, owner: RecordsOwner) {
		this.definition = definition;
		this.#owner = owner;
		const disk = definition.persist === undefined ? undefined : owner.store!;
		const stateDisk = disk && new Persistence(disk.store, disk.owner, "objects.job-states", definition.name);
		if (definition.state)
			this.#states = new RunStates(
				definition.state,
				{
					documents: owner.documents,
					changed: (id, ops) => this.#stateChanged(id, ops),
					held: (deadline) => owner.held(deadline),
				},
				stateDisk,
			);
		if (disk)
			this.#persisted = new PersistedRuns(
				new Persistence(disk.store, disk.owner, "objects.jobs", definition.name),
				stateDisk!,
			);
		this.running = new Running(owner.documents.batch, this.name);
	}
	check(definition: JobDefinition<unknown, unknown, unknown>): void {
		if (definition.version === this.definition.version && definition.fingerprint !== this.definition.fingerprint)
			throw new Error(`${this.name}: its schema changed without a version bump (version ${definition.version})`);
		if (definition.state && this.#states) this.#states.definition.check(definition.state);
	}
	redefine(definition: JobDefinition<unknown, unknown, unknown>): void {
		this.#declared = true;
		if (definition === this.definition) return;
		this.definition = definition;
		if (definition.state) {
			if (this.#states) this.#states.redefine(definition.state);
			else {
				const owner = this.#owner,
					disk = owner.store;
				const persistence =
					definition.persist && disk
						? new Persistence(disk.store, disk.owner, "objects.job-states", definition.name)
						: undefined;
				this.#states = new RunStates(
					definition.state,
					{
						documents: owner.documents,
						changed: (id, ops) => this.#stateChanged(id, ops),
						held: (deadline) => owner.held(deadline),
					},
					persistence,
				);
			}
		}
		this.#owner.documents.batch.within(() => {
			for (const run of this.#runs.values())
				if (run.entry) {
					const previous = run.entry;
					run.entry = this.#entry(run);
					this.running.replace(previous, run.entry);
				}
		}, this.#owner.context);
	}
	undeclare(): void {
		if (!this.#declared) return;
		this.#declared = false;
		this.#job = undefined;
		for (const run of this.#waiting)
			if (run.phase !== "blocked") void this.record(run, { kind: "block", run, reason: "version" });
		this.#waiting.clear();
	}
	async retryBlocked(context: Context): Promise<void> {
		if (!this.#declared || this.#ended) return;
		const retry = [...this.#runs.values()].filter(
			(run) => run.phase === "blocked" && (run.blocked === "finish_failed" || this.#takes(run)),
		);
		if (!retry.length) return;
		try {
			for (const run of retry)
				if (run.blockedPhase !== undefined) {
					this.#persisted!.forgetBlockedState(run.id);
					const states = this.#states,
						document = states && (await states.persistence.read(run.id, context));
					if (states && document) {
						const decoded = states.persistence.decode(document, states.definition.current, context);
						states.create(run.id, decoded.value, decoded.stored);
						if (run.outcome) run.outcome = { ...run.outcome, state: decoded.value };
					}
					run.resuming = run.outcome === undefined;
				}
			await this.#owner.documents.tx(
				(tx) => {
					for (const run of retry)
						if (this.#runs.get(run.id) === run && run.phase === "blocked")
							this.change(tx, {
								kind: "unblock",
								run,
								phase: run.outcome ? "finishing" : this.#persisted ? "pending" : "running",
							});
				},
				this.#owner.documents.own,
				context,
			);
		} catch {
			/* A later reload retries records whose state could not be read. */
		}
	}
	#takes(run: JobRun): boolean {
		return run.version === this.definition.version
			? run.fingerprint === this.definition.fingerprint
			: run.version < this.definition.version && this.definition.accepts[run.version] !== undefined;
	}
	argsOf(run: JobRun, definition = this.definition): JsonValue {
		if (run.version === definition.version) return run.args;
		if (run.mapped?.version !== definition.version)
			run.mapped = {
				version: definition.version,
				args: definition.accepts[run.version]!.args(run.args as never) as JsonValue,
			};
		return run.mapped.args;
	}
	outcomeOf(run: JobRun, context: Context): AnyOutcome {
		const outcome = run.outcome!;
		if (run.version === this.definition.version) return outcome;
		const args = this.argsOf(run),
			mapped = run.mapped!;
		if (mapped.outcome) return mapped.outcome;
		const base = { id: outcome.id, args, state: this.#states?.migrated(run.id, context) ?? outcome.state };
		return (mapped.outcome =
			outcome.kind === "done"
				? { ...base, kind: "done", result: this.definition.accepts[run.version]!.result(outcome.result as never) }
				: { ...base, kind: "failed", error: outcome.error });
	}
	#entry(run: JobRun): JsonValue {
		let args = run.args;
		if (run.phase !== "blocked" && run.version !== this.definition.version && this.#takes(run)) {
			try {
				args = this.argsOf(run);
			} catch {
				// Keep the stored arguments visible; the finish retries the adapter.
			}
		}
		return run.entryFor(this.stateOf(run.id), args);
	}
	get name(): string {
		return `${this.#owner.label} job ${this.definition.name}`;
	}
	get states(): RunStates | undefined {
		return this.#states;
	}
	get persisted(): boolean {
		return this.#persisted !== undefined;
	}
	stateOf(id: string): JsonObject | undefined {
		return this.#states?.value(id);
	}
	outcome(id: string, context: Context): Promise<AnyOutcome> {
		const run = this.#runs.get(id);
		return run
			? run.handle.outcome(context)
			: Promise.reject(
					new ObjectsError({
						code: "gone",
						message: `${this.name}: no unsettled run ${id}`,
					}),
				);
	}
	async abort(id: string, context: Context): Promise<"marked" | "terminal"> {
		const run = this.#runs.get(id);
		if (!run || this.#ended) return "terminal";
		if (run.phase === "blocked") {
			await this.record(run, { kind: "drop", run });
			return "marked";
		}
		if (!run.abortMarked)
			await this.record(run, {
				kind: "update",
				run,
				fields: { abortMarked: true },
			});
		if (run.phase !== "finishing") {
			run.invocation?.abort.abort(
				new ObjectsError({
					code: "aborted",
					message: `${this.name}: run ${id} aborted`,
				}),
			);
			await run.over(context);
		}
		return "marked";
	}
	stage(tx: Transaction, args: unknown, context: Context, options: StartOptions): Run<AnyOutcome> {
		check(validatorFor(this.definition.args, context), args, "args", context);
		const previous = tx.staged<Staging>(this),
			key = options.key;
		const known =
			key === undefined ? undefined : (previous?.started.find((run) => run.key === key) ?? this.#keys.get(key));
		if (known && known !== previous?.finishing) return known.handle;
		const limit = this.definition.concurrency,
			active = this.#active + (previous?.started.length ?? 0) - Number(previous?.finishing !== undefined);
		if (limit !== undefined && active >= limit)
			throw new ObjectsError({
				code: "unavailable",
				reason: "busy",
				message: `${this.name}: at its concurrency limit (${limit})`,
			});
		const trace = this.persisted ? context.telemetry.propagation?.inject(context.telemetry) : undefined;
		const run = new JobRun(
			uuidv7(),
			this.definition.version,
			this.definition.fingerprint,
			key,
			args as JsonValue,
			this.persisted ? "pending" : "running",
			trace,
		);
		const pending = this.staging(tx);
		pending.started.push(run);
		this.change(tx, { kind: "create", run });
		const state = this.definition.state?.initial(context);
		if (state !== undefined) pending.adopts.push(this.#states!.stageCreate(run.id, state, () => this.#writes(tx)));
		return run.handle;
	}
	change(tx: Transaction, change: RecordChange): void {
		const staged = this.staging(tx),
			run = change.run;
		staged.changes.push(change);
		if (change.kind === "delete" || change.kind === "drop") {
			if (this.#states?.current(run.id)) tx.retireSlot(this.#states, run.id);
			if (this.#persisted) staged.adopts.push(this.#persisted.stageRetire(run.id, this.#writes(tx)));
			return;
		}
		if (this.#persisted) {
			const fields: StoredFields =
				change.kind === "create"
					? {}
					: change.kind === "unblock"
						? { phase: change.phase, blocked: undefined, finishFailures: 0 }
						: change.kind === "update"
							? change.fields
							: change.kind === "outcome"
								? { phase: "finishing", outcome: change.outcome }
								: { phase: "blocked", blocked: change.reason };
			staged.adopts.push(this.#persisted.stage(run.id, storedRun(run, fields), this.#writes(tx)));
		}
	}
	staging(tx: Transaction): Staging {
		return tx.stage(this, () => {
			const changes: Adoption[] = [],
				adopts: (() => void)[] = [];
			return {
				started: [],
				changes,
				adopts,
				finishing: undefined,
				adopt: () => {
					if (!this.#ended) {
						for (const adopt of adopts) adopt();
						for (const change of changes) this.#adopt(change);
					}
				},
				committed: () => {
					for (const change of changes) {
						if (!this.#ended) this.#committed(change);
						else if (change.kind === "create") change.run.reject(this.#ended);
					}
				},
				discarded: () => {
					for (const change of changes)
						if (change.kind === "create")
							change.run.reject(
								new ObjectsError({
									code: "released",
									reason: "discarded",
									message: `${this.name}: the start's transaction was discarded`,
								}),
							);
				},
			};
		});
	}
	async load(context: Context): Promise<void> {
		if (!this.#persisted || this.#loaded) return;
		const restored: Restored[] = [];
		try {
			for (const loaded of await this.#persisted.load(context)) restored.push(await this.#restore(loaded, context));
			if (restored.length)
				await this.#owner.documents.tx(
					(tx) => {
						const staging = this.staging(tx);
						for (const { run } of restored) staging.changes.push({ kind: "restore", run });
						for (const { change } of restored) if (change) this.change(tx, change);
					},
					this.#owner.documents.own,
					context,
				);
		} catch (error) {
			this.#persisted.drop();
			for (const { run } of restored) this.#states?.retire(run.id);
			throw error;
		}
		this.#loaded = true;
		for (const { run, change } of restored)
			if (
				change?.kind === "outcome" &&
				change.outcome.kind === "failed" &&
				change.outcome.error.kind === "restart_limit"
			)
				this.report({
					kind: "job_interrupted",
					id: run.id,
					restarts: change.outcome.error.restarts,
				});
		for (const { run } of restored) this.#schedule(run);
	}
	attach(job: AttachedJob): void {
		if (this.#ended) return;
		this.#job = job;
		const waiting = [...this.#waiting];
		this.#waiting.clear();
		for (const run of waiting) this.#dispatch(run, job);
	}
	detach(job: AttachedJob, finishing: Iterable<JobRun>): void {
		if (this.#job === job) this.#job = undefined;
		for (const run of finishing) this.#schedule(run);
	}
	requeue(run: JobRun): void {
		this.#schedule(run);
	}
	reserve(tx: Transaction, run: JobRun): void {
		this.change(tx, { kind: "update", run, fields: { phase: "running" } });
	}
	progressed(tx: Transaction, run: JobRun): void {
		if (run.restarts) this.change(tx, { kind: "update", run, fields: { restarts: 0 } });
	}
	settled(run: JobRun, result: Settled): void {
		void this.#recordOutcome(run, result);
	}
	cut(run: JobRun, error: ObjectsError, reason: "restart" | "reload" = "restart"): void {
		const invocation = run.invocation!;
		invocation.settle();
		this.#owner.documents.fence(invocation.token);
		invocation.abort.abort(error);
		if (this.#persisted) {
			run.phase = "stopped";
			run.resuming = true;
			this.#stopped.add(run);
			if (!this.#ended) this.#schedule(run);
		} else if (!this.#ended)
			void this.#recordOutcome(
				run,
				reason === "reload" ? { kind: "failed", error: { kind: "aborted", reason: "reload" } } : interrupted,
			);
	}
	async record(run: JobRun, change: RecordChange): Promise<void> {
		try {
			await this.#owner.documents.tx(
				(tx) => {
					if (this.#runs.get(run.id) === run) this.change(tx, change);
				},
				this.#owner.documents.own,
				this.#owner.context,
			);
		} catch {
			/* The object's end owns pending run outcomes. */
		}
	}
	async writeAtClose(context: Context): Promise<void> {
		if (!this.#persisted) return;
		const writes: StagedWrite[] = [],
			adopts: (() => void)[] = [];
		for (const run of this.#stopped) adopts.push(this.#persisted.stage(run.id, storedRun(run), writes));
		this.#stopped.clear();
		for (const id of this.#states?.heldIds ?? []) {
			const adopt = this.#states!.stageHeld(id, writes);
			if (adopt) adopts.push(adopt);
		}
		if (!writes.length) return;
		try {
			await this.#owner.store!.store.commit(
				writes,
				{
					admit: () => true,
					adopt: () => {
						for (const adopt of adopts) adopt();
					},
				},
				withoutAbortSignal(context),
			);
		} catch {
			/* Recovery uses the last committed records when closing fails. */
		}
	}
	async flushHeld(now: number): Promise<void> {
		const states = this.#states;
		if (!states?.heldIds.length) return;
		try {
			await this.#owner.documents.tx(
				(tx) => {
					const staging = this.staging(tx);
					for (const id of states.heldIds)
						if (states.deadline(id) <= now) {
							const adopt = states.stageHeld(id, this.#writes(tx));
							if (adopt) staging.adopts.push(adopt);
						}
				},
				this.#owner.documents.own,
				this.#owner.context,
			);
		} catch {
			/* The close writer flushes a sealed object. */
		}
	}
	nextDeadline(): number {
		return Math.min(Infinity, ...(this.#states?.heldIds.map((id) => this.#states!.deadline(id)) ?? []));
	}
	end(error: ObjectsError): void {
		if (this.#ended) return;
		this.#ended = error;
		this.#job = undefined;
		this.#waiting.clear();
		for (const run of this.#runs.values()) {
			if (run.phase === "blocked" && !this.#persisted) this.report({ kind: "job_dropped", id: run.id });
			run.invocation?.abort.abort(error);
			run.reject(error);
			if (run.invocation?.state !== "running") run.invocation?.ended();
		}
		if (this.#active) this.#owner.countRuns(-this.#active);
	}
	drop(): void {
		this.#runs.clear();
		this.#keys.clear();
		this.#states?.drop();
		this.#persisted?.drop();
		this.running.end();
	}
	report(
		error:
			| {
					readonly kind: "job_failed" | "job_finish_failed";
					readonly id: string;
					readonly error: unknown;
			  }
			| { readonly kind: "job_dropped"; readonly id: string }
			| {
					readonly kind: "job_interrupted";
					readonly id: string;
					readonly restarts: number;
			  },
	): void {
		this.#owner.host.report({
			...error,
			object: this.#owner.label,
			job: this.definition.name,
		});
	}
	#writes(tx: Transaction): StagedWrite[] {
		return tx.stageStore(this.#owner.store!.store);
	}
	async #restore({ id, record }: LoadedRecord, context: Context): Promise<Restored> {
		const run = new JobRun(id, record.version, record.fingerprint, record.key, record.args, record.phase, record.trace);
		run.restarts = record.restarts;
		run.finishFailures = record.finishFailures;
		run.abortMarked = record.abort === true;
		if (record.version !== this.definition.version || record.fingerprint !== this.definition.fingerprint) {
			run.phase = "blocked";
			run.blocked = "version";
			run.blockedPhase = record.phase;
			if (record.outcome) run.outcome = outcomeOf(record.outcome, id, record.args, undefined);
			await this.#persisted!.findBlockedState(id, context);
			return { run, change: undefined };
		}
		const document = await this.#states?.persistence.read(id, context);
		if (document) {
			const states = this.#states!,
				decoded = states.persistence.decode(document, states.definition.current, context);
			states.create(id, decoded.value, decoded.stored);
		}
		if (record.outcome) run.outcome = outcomeOf(record.outcome, id, record.args, this.stateOf(id));
		run.blocked = record.blocked;
		if (record.phase === "running") {
			const restarts = record.restarts + 1;
			run.resuming = true;
			if (restarts < 5)
				return {
					run,
					change: {
						kind: "update",
						run,
						fields: { phase: "pending", restarts },
					},
				};
			run.restarts = restarts;
			return {
				run,
				change: {
					kind: "outcome",
					run,
					outcome: this.#outcome(run, {
						kind: "failed",
						error: { kind: "restart_limit", restarts },
					}),
				},
			};
		}
		if (record.phase === "stopped") {
			run.resuming = true;
			return {
				run,
				change: { kind: "update", run, fields: { phase: "pending" } },
			};
		}
		if (record.phase === "pending") run.resuming = true;
		return { run, change: undefined };
	}
	async #recordOutcome(run: JobRun, result: Settled): Promise<void> {
		try {
			await this.#owner.documents.tx(
				(tx) => {
					this.change(tx, {
						kind: "outcome",
						run,
						outcome: this.#outcome(run, result),
					});
					const adopt = this.#persisted ? this.#states?.stageHeld(run.id, this.#writes(tx)) : undefined;
					if (adopt) this.staging(tx).adopts.push(adopt);
				},
				this.#owner.documents.own,
				this.#owner.context,
			);
		} catch {
			return;
		} finally {
			run.invocation?.ended();
		}
		this.#schedule(run);
	}
	#outcome(run: JobRun, result: Settled): AnyOutcome {
		return {
			id: run.id,
			args: run.args,
			state: this.stateOf(run.id),
			...result,
		};
	}
	#schedule(run: JobRun): void {
		if (this.#ended || this.#runs.get(run.id) !== run) return;
		if (!this.#declared && !run.invoked && run.phase !== "blocked") {
			void this.record(run, { kind: "block", run, reason: "version" });
			return;
		}
		if (this.#job) this.#dispatch(run, this.#job);
		else this.#waiting.add(run);
	}
	#dispatch(run: JobRun, job: AttachedJob): void {
		if (this.#runs.get(run.id) !== run) return;
		if (run.phase !== "blocked" && !run.invoked && !this.#takes(run)) {
			void this.record(run, { kind: "block", run, reason: "version" });
			return;
		}
		if (run.phase === "finishing") {
			job.finish(run);
			return;
		}
		if (run.phase === "blocked" || run.invoked) return;
		if (run.abortMarked) {
			void this.#recordOutcome(run, aborted);
			return;
		}
		if (run.resuming && this.definition.persist?.resume === "abandon") {
			void this.#recordOutcome(run, interrupted);
			return;
		}
		run.resuming = false;
		job.invoke(run);
	}
	#adopt(change: Adoption): void {
		const run = change.run;
		if (change.kind === "create" || change.kind === "restore") {
			this.#runs.set(run.id, run);
			if (run.key !== undefined) this.#keys.set(run.key, run);
			if (run.phase !== "blocked") {
				this.#active++;
				this.#owner.countRuns(1);
			}
			run.entry = this.#entry(run);
			this.running.add(run.entry);
			return;
		}
		if (change.kind === "delete" || change.kind === "drop") {
			this.#runs.delete(run.id);
			if (run.key !== undefined && this.#keys.get(run.key) === run) this.#keys.delete(run.key);
			if (change.kind === "delete") this.#active--;
			this.running.remove(run.entry!);
			run.entry = undefined;
			return;
		}
		if (change.kind === "unblock") {
			run.phase = change.phase;
			run.blocked = undefined;
			run.blockedPhase = undefined;
			run.finishFailures = 0;
			this.#active++;
		} else if (change.kind === "update") Object.assign(run, change.fields);
		else if (change.kind === "outcome") {
			run.phase = "finishing";
			run.outcome = change.outcome;
		} else {
			run.phase = "blocked";
			run.blocked = change.reason;
			this.#active--;
		}
		const before = run.entry!;
		run.entry = this.#entry(run);
		this.running.replace(before, run.entry);
	}
	#committed(change: Adoption): void {
		const run = change.run;
		if (change.kind === "unblock") {
			this.#owner.countRuns(1);
			queueMicrotask(() => this.#schedule(run));
		} else if (change.kind === "create") queueMicrotask(() => this.#schedule(run));
		else if (change.kind === "delete") {
			this.#owner.countRuns(-1);
			run.resolve(run.outcome!);
		} else if (change.kind === "block") this.#owner.countRuns(-1);
		else if (change.kind === "drop") {
			this.report({ kind: "job_dropped", id: run.id });
			run.reject(
				new ObjectsError({
					code: "aborted",
					message: `${this.name}: run ${run.id} dropped`,
				}),
			);
		}
	}
	#stateChanged(id: string, ops: readonly Op[]): void {
		const run = this.#runs.get(id);
		if (run?.entry === undefined) return;
		const before = run.entry;
		run.entry = this.#entry(run);
		this.running.stateChanged(before, run.entry, ops);
	}
}
