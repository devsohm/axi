import { SessionFailed } from "../errors.ts";

export type Ran<Value> = { readonly value: Value; readonly after?: Promise<void> };
type Job = { readonly index: number; hit: boolean; ends?: (() => void)[] };
const ignore = (): void => {};

export class MutationLine {
	readonly #failure: () => { readonly error: unknown } | undefined;
	#tail = Promise.resolve();
	#fence = Promise.resolve();
	#next = 0;
	#current: Job | undefined;
	#lastDelivered = -1;
	#failedAt: number | undefined;
	readonly #own = new Set<number>();
	#outstanding = 0;
	#room: PromiseWithResolvers<void> | undefined;
	constructor(failure: () => { readonly error: unknown } | undefined) {
		this.#failure = failure;
	}
	get current(): Job | undefined {
		return this.#current;
	}
	get outstanding(): number {
		return this.#outstanding;
	}
	fail(at: number | undefined, own: readonly number[]): void {
		this.#failedAt = at ?? this.#current?.index ?? this.#lastDelivered;
		for (const index of own) this.#own.add(index);
	}
	onJobEnd(end: () => void): void {
		if (this.#current) (this.#current.ends ??= []).push(end);
		else end();
	}
	enqueue<Value>(work: (index: number) => Promise<Ran<Value>>, exempt = false): Promise<Value> {
		const job: Job = { index: this.#next++, hit: false };
		const ran = this.#tail.then(async () => {
			while (this.#outstanding >= 256) {
				this.#room ??= Promise.withResolvers<void>();
				await this.#room.promise;
			}
			this.#outstanding++;
			return this.#run(job, work);
		});
		this.#tail = ran.then(ignore, ignore);
		const outcome = ran.then(
			(result) => {
				if (result.after === undefined) {
					this.#ended(job);
					return result.value;
				}
				return result.after.then(
					() => {
						this.#ended(job);
						return result.value;
					},
					(error) => {
						this.#ended(job);
						throw error;
					},
				);
			},
			(error) => {
				this.#ended(job);
				throw error;
			},
		);
		outcome.catch(ignore);
		const before = this.#fence;
		this.#fence = before.then(() => outcome).then(ignore, ignore);
		const delivered = (fenced: boolean): Promise<Value> =>
			(fenced ? before.then(() => outcome) : outcome).then(
				(value) => {
					this.#release(job.index, fenced);
					if (this.#poisoned(job.index)) throw new SessionFailed(this.#failure()!.error);
					return value;
				},
				(error) => {
					this.#release(job.index, fenced);
					throw this.#poisoned(job.index) ? new SessionFailed(this.#failure()!.error) : error;
				},
			);
		return exempt
			? ran.then(
					(result) => delivered(job.hit || result.after !== undefined),
					() => delivered(job.hit),
				)
			: delivered(true);
	}
	maintain<Value>(work: (index: number) => Promise<Value>): Promise<Value> {
		const job: Job = { index: this.#next++, hit: false };
		const ran = this.#tail.then(() => this.#run(job, work));
		this.#tail = ran.then(ignore, ignore);
		return ran;
	}
	async #run<Value>(job: Job, work: (index: number) => Promise<Value>): Promise<Value> {
		this.#current = job;
		try {
			return await work(job.index);
		} finally {
			this.#current = undefined;
		}
	}
	#ended(job: Job): void {
		const ends = job.ends;
		job.ends = undefined;
		if (ends) for (const end of ends) end();
	}
	#release(index: number, fenced: boolean): void {
		if (fenced) this.#lastDelivered = index;
		this.#outstanding--;
		if (this.#room && this.#outstanding < 256) {
			const room = this.#room;
			this.#room = undefined;
			room.resolve();
		}
	}
	#poisoned(index: number): boolean {
		return this.#failedAt !== undefined && index > this.#failedAt && !this.#own.has(index);
	}
}
