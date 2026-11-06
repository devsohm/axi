import { ObjectsError, isObjectsError } from "../data/index.ts";
import { asObjectsError } from "../data/internal.ts";
import { type Batch, FollowedSource, type NativeStart } from "../state/internal.ts";
import type { RegistryContribution } from "./contribution.ts";
import type { RegistryRecord } from "./record.ts";

export interface RegistryWaiter { dependencyMoved(): void; closed(error: ObjectsError): void }
type Mapping = { from: unknown; adapter: (current: never) => unknown; value: unknown; contributions: readonly RegistryContribution[] | undefined };
type Availability = { kind: "usable" } | { kind: "failed"; error: unknown };
type Attachment = { kind: "open"; record: RegistryRecord } | { kind: "closed"; last: NativeStart<unknown> };
function sameError(a: unknown, b: unknown): boolean {
	return a === b || isObjectsError(a) && isObjectsError(b) && a.code === b.code && a.reason === b.reason && a.message === b.message;
}

export class RegistryValueSource extends FollowedSource<unknown> {
	readonly name: string;
	readonly version: number;
	#attachment: Attachment;
	readonly #readers = new Set<object>();
	readonly #waiters = new Set<{ waiter: RegistryWaiter }>();
	#told: Availability | undefined;
	#mapped: Mapping | undefined;
	#mapFailure: { from: unknown; adapter: (current: never) => unknown; error: unknown } | undefined;
	constructor(record: RegistryRecord, version: number, batch: Batch) {
		super(batch); this.name = record.name; this.version = version; this.#attachment = { kind: "open", record };
	}
	get value(): unknown {
		const current = this.start();
		if (current.kind === "value") return current.value;
		if (current.last) return current.last.value;
		throw current.error;
	}
	override start(): NativeStart<unknown> {
		const attachment = this.#attachment;
		if (attachment.kind === "closed") return attachment.last;
		const current = this.#read(attachment.record);
		if (this.#waiters.size) this.#notify(current);
		return current;
	}
	override current(): unknown {
		const current = this.start();
		if (current.kind === "failed") throw current.error;
		return current.value;
	}
	override get watched(): boolean { return super.watched || this.#waiters.size > 0 }
	read(): () => void {
		const token = {};
		this.#readers.add(token);
		return () => { this.#readers.delete(token); if (!this.#readers.size && !super.watched) this.#drop() };
	}
	wait(waiter: RegistryWaiter): () => void {
		const token = { waiter };
		if (!this.#waiters.size) this.#told = undefined;
		this.#waiters.add(token);
		return () => {
			this.#waiters.delete(token);
			if (!this.#waiters.size) {
				this.#told = undefined;
				if (this.#attachment.kind === "open") this.#attachment.record.clock?.stop(this);
			}
		};
	}
	recomposed(): void { this.changed() }
	relisted(): void { this.list() }
	close(): void {
		const attachment = this.#attachment;
		let last: NativeStart<unknown>;
		try { last = this.start() } catch (error) { last = { kind: "failed", error, last: undefined } }
		if (attachment.kind === "open") attachment.record.clock?.stop(this);
		this.#attachment = { kind: "closed", last };
		this.#readers.clear();
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		const error = new ObjectsError({ code: "released", reason: "closed", message: `registry ${this.name}: closed` });
		for (const { waiter } of waiters) waiter.closed(error);
		this.#told = undefined;
		this.#drop();
		this.end();
	}
	protected override unfollowed(): void { if (!this.#readers.size) this.#drop() }
	#notify(current: NativeStart<unknown>): void {
		const previous = this.#told;
		const clock = this.#attachment.kind === "open" ? this.#attachment.record.clock : undefined;
		let next: Availability;
		if (current.kind === "value" || current.last) {
			if (previous?.kind === "usable") return;
			clock?.stop(this);
			next = { kind: "usable" };
		} else {
			if (previous?.kind === "failed" && sameError(previous.error, current.error)) return;
			const error = asObjectsError(current.error, `registry ${this.name}`);
			if (previous?.kind === "failed") clock?.failed(this, error);
			else clock?.start(this, `registry ${this.name}`, error);
			next = { kind: "failed", error: current.error };
		}
		this.#told = next;
		if (previous) for (const { waiter } of this.#waiters) waiter.dependencyMoved();
	}
	#drop(): void { this.#mapped = undefined; this.#mapFailure = undefined }
	#read(record: RegistryRecord): NativeStart<unknown> {
		const version = record.providedVersion;
		if (version === undefined || version === this.version) return record.start();
		const adapter = version > this.version ? record.valueAdapter(this.version) : undefined;
		if (!adapter) return { kind: "failed", error: new ObjectsError({ code: "contract_mismatch",
			message: `registry ${this.name}: version ${this.version} is not served here (version ${version} is)` }), last: undefined };
		const current = record.start();
		if (current.kind === "failed" && !current.last) return current;
		const from = current.kind === "value" ? current.value : current.last!.value;
		if (this.#mapped?.contributions && !record.inTable(this.#mapped.contributions)) this.#mapped = undefined;
		if (this.#mapped && this.#mapped.from === from && this.#mapped.adapter === adapter) this.#mapFailure = undefined;
		else if (!this.#mapFailure || this.#mapFailure.from !== from || this.#mapFailure.adapter !== adapter) {
			try {
				this.#mapped = { from, adapter, value: record.adapt(() => adapter(from as never)), contributions: record.composedFrom };
				this.#mapFailure = undefined;
			} catch (error) {
				if (!this.#mapFailure) record.failed(error);
				this.#mapFailure = { from, adapter, error };
			}
		}
		const last = this.#mapped ? { value: this.#mapped.value } : undefined;
		if (this.#mapFailure) return { kind: "failed", error: this.#mapFailure.error, last };
		return current.kind === "failed" ? { kind: "failed", error: current.error, last } : { kind: "value", value: last!.value };
	}
}
