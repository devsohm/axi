import type { AssistantMessage } from "../types.ts";
const terminal =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded/i;
const transient = new RegExp(
	[
		"overloaded",
		"server_busy",
		"servers are currently busy",
		"currently experiencing high demand",
		"model is at capacity",
		"rate.?limit",
		"too many requests",
		"(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])",
		"service.?(?:is.?)?(?:temporarily.?)?unavailable",
		"server.?error",
		"internal.?error",
		"provider.?returned.?(?:an.?)?error",
		"exceeded request buffer limit while retrying upstream",
		"unable to forward upstream",
		"upstream.?request.?failed",
		"upstream_stream_read_error",
		"stream was interrupted",
		"stream disconnected before completion",
		"http/?2 stream failed",
		"network.?error",
		"connection.?error",
		"connection.?refused",
		"connection.?lost",
		"other side closed",
		"fetch failed",
		"request to \\S+ failed, reason:",
		"getaddrinfo",
		"ENOTFOUND",
		"EAI_AGAIN",
		"upstream.?connect",
		"reset before headers",
		"socket hang up",
		"socket connection was closed",
		"timed? out",
		"timeout",
		"terminated",
		"websocket.?closed",
		"websocket.?error",
		"ended without",
		"stream ended before message_stop",
		"stream ended before a terminal response event",
		"http2 request did not get a response",
		"pending stream has been canceled",
		"retry delay",
		"you can retry your request",
		"try your request again",
		"please retry your request",
		"ResourceExhausted",
		"subscription_sharing_usage_unavailable",
		"subscription_sharing_user_unavailable",
	].join("|"),
	"i",
);
export interface RetryPolicy {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs?: number;
}
export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;
export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const computed = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(
		Number.isSafeInteger(computed) ? computed : Number.MAX_SAFE_INTEGER,
		policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	);
}
export interface RetryCallbacks {
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	onRetryAttemptStart?: () => void | Promise<void>;
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		!!message.errorMessage &&
		!terminal.test(message.errorMessage) &&
		transient.test(message.errorMessage)
	);
}
class BackoffAbort extends Error {
	constructor() {
		super("Aborted");
	}
}
function backoff(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new BackoffAbort());
			return;
		}
		const timer = setTimeout(resolve, milliseconds);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new BackoffAbort());
			},
			{ once: true },
		);
	});
}
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maximum = policy?.enabled ? policy.maxRetries : 0;
	let attempt = 0;
	for (;;) {
		const response = await produce();
		if (response.stopReason === "aborted") {
			if (attempt) await callbacks?.onRetryFinished?.(false, attempt);
			return response;
		}
		if (response.stopReason !== "error") {
			if (attempt) await callbacks?.onRetryFinished?.(true, attempt);
			return response;
		}
		if (attempt >= maximum || !isRetryableAssistantError(response)) {
			if (attempt) await callbacks?.onRetryFinished?.(false, attempt, response.errorMessage);
			return response;
		}
		attempt++;
		const errorMessage = response.errorMessage || "Unknown error",
			delay = retryDelayMs(policy!, attempt);
		await callbacks?.onRetryScheduled?.(attempt, maximum, delay, errorMessage);
		try {
			await backoff(delay, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, errorMessage);
			if (error instanceof BackoffAbort) {
				const { errorMessage: _error, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}
