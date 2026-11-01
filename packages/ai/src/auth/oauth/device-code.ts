import { sleep } from "../../utils/sleep.ts";
export type OAuthDeviceCodePollResult<T> =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string }
	| { status: "complete"; value: T };
export type OAuthDeviceCodePollOptions<T> = {
	intervalSeconds?: number;
	expiresInSeconds?: number;
	waitBeforeFirstPoll?: boolean;
	poll: () => Promise<OAuthDeviceCodePollResult<T>>;
	signal: AbortSignal;
};
export async function abortableSleep(ms: number, signal: AbortSignal, cancelMessage: string): Promise<void> {
	try {
		await sleep(ms, signal);
	} catch {
		throw new Error(cancelMessage);
	}
}
export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodePollOptions<T>): Promise<T> {
	const deadline =
		typeof options.expiresInSeconds === "number" ? Date.now() + options.expiresInSeconds * 1000 : Infinity;
	let interval = Math.max(1000, Math.floor((options.intervalSeconds ?? 5) * 1000)),
		slowed = false;
	const pause = () => abortableSleep(Math.min(interval, deadline - Date.now()), options.signal, "Login cancelled");
	if (options.waitBeforeFirstPoll && deadline > Date.now()) await pause();
	while (Date.now() < deadline) {
		if (options.signal.aborted) throw new Error("Login cancelled");
		const response = await options.poll();
		if (response.status === "complete") return response.value;
		if (response.status === "failed") throw new Error(response.message);
		if (response.status === "slow_down") {
			slowed = true;
			const supplied = response.intervalSeconds;
			interval =
				typeof supplied === "number" && Number.isFinite(supplied) && supplied > 0
					? Math.max(1000, Math.floor(supplied * 1000))
					: Math.max(1000, interval + 5000);
		}
		if (deadline <= Date.now()) break;
		await pause();
	}
	throw new Error(
		slowed
			? "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again."
			: "Device flow timed out",
	);
}
