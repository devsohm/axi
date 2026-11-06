import type { TelemetryMetrics } from "@axi/telemetry";
import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import { objectsMetrics, type ObjectsMetrics } from "../telemetry.ts";

export type BatchError =
	| { readonly kind: "listener_error"; readonly error: unknown }
	| { readonly kind: "delivery_failed"; readonly error: unknown };
export interface Delivered { deliver(context: Context): void }

export class Batch {
	readonly reportListener: (error: unknown) => void;
	readonly #report: (error: BatchError) => void;
	readonly #metrics: ObjectsMetrics;
	#running = false;
	#computing = false;
	#flushing = false;
	#deliveries: Delivered[] = [];
	#flushes: ((context: Context) => void)[] = [];
	#deferred: (() => void)[] = [];
	#scheduled: (() => void)[] | undefined;

	constructor(report: (error: BatchError) => void, metrics: TelemetryMetrics | undefined) {
		this.#report = report;
		this.#metrics = objectsMetrics(metrics);
		this.reportListener = (error) => report({ kind: "listener_error", error });
	}
	get running(): boolean { return this.#running }
	assertOutside(operation: string): void {
		if (this.#running) throw invalid("reentrant", `${operation} inside a commit or a derive compute`);
	}
	assertNotComputing(operation: string): void {
		if (this.#computing) throw invalid("reentrant", `${operation} inside a derive compute or a compose`);
	}
	run<T>(work: () => T): T {
		const previous = this.#running;
		this.#running = true;
		try { return work() } finally { this.#running = previous }
	}
	compute<T>(work: () => T): T {
		const previous = this.#computing;
		this.#computing = true;
		try { return this.run(work) } finally { this.#computing = previous }
	}
	commit(adopt: () => void, context: Context): void {
		this.run(() => {
			try {
				adopt();
				for (const source of this.#deliveries) {
					try { source.deliver(context) } catch (error) { this.#report({ kind: "delivery_failed", error }) }
				}
				this.#flushing = true;
				for (const flush of this.#flushes) {
					try { flush(context) } catch (error) { this.#report({ kind: "delivery_failed", error }) }
				}
			} finally {
				this.#deliveries = [];
				this.#flushes = [];
				this.#flushing = false;
			}
		});
		if (this.#deferred.length > 0) {
			const work = this.#deferred;
			this.#deferred = [];
			this.commit(() => { for (const adopt of work) adopt() }, context);
		}
	}
	within(adopt: () => void, context: Context): void {
		if (this.#flushing) this.#deferred.push(adopt);
		else if (this.#running) adopt();
		else this.commit(adopt, context);
	}
	soon(adopt: () => void, context: Context): void {
		if (this.#scheduled) { this.#scheduled.push(adopt); return }
		const work = [adopt];
		this.#scheduled = work;
		queueMicrotask(() => {
			this.#scheduled = undefined;
			this.commit(() => { for (const adopt of work) adopt() }, context);
		});
	}
	changed(source: Delivered): void { this.#deliveries.push(source) }
	flushing(flush: (context: Context) => void): void { this.#flushes.push(flush) }
	count(counter: "objects.derive.computes" | "objects.derive.diffs" | "objects.registry.composes" | "objects.registry.adapts" | "objects.contract.adapts"): void {
		this.#metrics.counter(counter).add(1);
	}
}
