import type { Context } from "@axi/objects/context";
import type { WatchEnd } from "@axi/objects/watch";

type Target<Call> = {
	advance(call: Call, context: Context): void;
	end(end: WatchEnd): void;
};
type Attachment<Call> = {
	target: Target<Call>;
	detach: () => void;
	report: (error: unknown, context?: Context) => void;
};

export class GuardedObserver<Call> {
	#attachment: Attachment<Call> | undefined;
	constructor(target: Target<Call>, detach: () => void, report: Attachment<Call>["report"]) {
		this.#attachment = { target, detach, report };
	}
	advance(call: Call, context: Context): void {
		const attachment = this.#attachment;
		if (attachment === undefined) return;
		const fail = (error: unknown): void => {
			attachment.report(error, context);
			if (this.#attachment === undefined) return;
			this.detach();
			contained(() => attachment.target.end({ kind: "listener_error", error: asError(error) }), attachment.report);
		};
		try {
			const result: unknown = attachment.target.advance(call, context);
			if (typeof (result as { then?: unknown } | null)?.then === "function") Promise.resolve(result).catch(fail);
		} catch (error) {
			fail(error);
		}
	}
	end(end: WatchEnd): void {
		const attachment = this.#attachment;
		if (attachment === undefined) return;
		this.detach();
		contained(() => attachment.target.end(end), attachment.report);
	}
	detach(): void {
		const attachment = this.#attachment;
		this.#attachment = undefined;
		attachment?.detach();
	}
}

function asError(value: unknown): Error {
	if (value instanceof Error) return value;
	try {
		return new Error(String(value));
	} catch {
		return new Error(Object.prototype.toString.call(value));
	}
}

export function contained(callback: () => unknown, onError: (error: unknown) => void): void {
	try {
		const result = callback();
		if (
			result !== null &&
			(typeof result === "object" || typeof result === "function") &&
			typeof Reflect.get(result, "then") === "function"
		)
			Promise.resolve(result).catch(onError);
	} catch (error) {
		onError(error);
	}
}
