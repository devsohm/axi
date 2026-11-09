import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { AssistantMessage, Model } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { shortHash } from "../utils/hash.ts";
import { anthropicReply } from "./anthropic-request.ts";

type Params = MessageCreateParamsStreaming;
type ThreadParams = Params & { thread?: { type: "create" } | { type: "continue"; previous_message_id: string } };
export interface PendingThread {
	session: string;
	body: ThreadParams;
}
interface Checkpoint {
	count: number;
	digest: string;
	reply: string;
}
const checkpoints = new Map<string, Checkpoint | "disabled">();
registerSessionResourceCleanup((session) => {
	if (session) checkpoints.delete(session);
	else checkpoints.clear();
});

function remember(session: string, value: Checkpoint | "disabled"): void {
	checkpoints.delete(session);
	checkpoints.set(session, value);
	if (checkpoints.size > 10000) {
		const first = checkpoints.keys().next();
		if (!first.done) checkpoints.delete(first.value);
	}
}
function fingerprint(model: Model<"anthropic-messages">, body: Params, messages: readonly unknown[]): string {
	const settings = {
		provider: model.provider,
		url: model.baseUrl,
		model: body.model,
		system: body.system,
		tools: body.tools,
		thinking: body.thinking,
		output: body.output_config,
		choice: body.tool_choice,
		betas: body.betas,
		fallbacks: body.fallbacks,
	};
	const history = JSON.stringify(messages, (key, value: unknown) => {
		if (key === "cache_control") return undefined;
		return key === "content" && typeof value === "string" ? [{ type: "text", text: value }] : value;
	});
	return shortHash(JSON.stringify(settings) + history);
}
export function prepareAnthropicThread(
	session: string,
	model: Model<"anthropic-messages">,
	body: Params,
): PendingThread | undefined {
	const prior = checkpoints.get(session);
	if (prior === "disabled") return;
	if (
		!prior ||
		body.messages.length <= prior.count ||
		fingerprint(model, body, body.messages.slice(0, prior.count)) !== prior.digest
	)
		return { session, body: { ...body, thread: { type: "create" } } };
	checkpoints.delete(session);
	const { system: _system, tools: _tools, ...rest } = body;
	return {
		session,
		body: {
			...rest,
			messages: body.messages.slice(prior.count),
			thread: { type: "continue", previous_message_id: prior.reply },
		},
	};
}
function errorCode(error: unknown): string | undefined {
	let part: unknown = error;
	for (const key of ["error", "details", "error_code"]) {
		if (!part || typeof part !== "object" || !(key in part)) return;
		part = (part as Record<string, unknown>)[key];
	}
	return typeof part === "string" ? part : undefined;
}
export async function sendAnthropicThread(
	prepared: PendingThread,
	full: Params,
	send: (body: ThreadParams) => Promise<Response>,
	output: AssistantMessage,
	signal?: AbortSignal,
): Promise<{ response: Response; thread?: PendingThread }> {
	try {
		return { response: await send(prepared.body), thread: prepared };
	} catch (error) {
		if (signal?.aborted || !(error instanceof Anthropic.APIError)) throw error;
		const code = errorCode(error.error);
		const retry =
			code !== undefined &&
			[
				"thread_not_found",
				"thread_already_continued",
				"thread_continue_in_flight",
				"thread_fingerprint_mismatch",
			].includes(code);
		const unsupported =
			code === "thread_unsupported_request" ||
			(code === undefined && error.status === 400 && error.message.includes("thread"));
		if (!retry && !unsupported) throw error;
		appendAssistantMessageDiagnostic(output, {
			type: "anthropic_thread_fallback",
			timestamp: Date.now(),
			error: { message: error.message },
			details: { reason: code ?? String(error.status) },
		});
		if (retry) {
			const thread: PendingThread = { session: prepared.session, body: { ...full, thread: { type: "create" } } };
			return { response: await send(thread.body), thread };
		}
		const response = await send(full);
		remember(prepared.session, "disabled");
		return { response };
	}
}
export function recordAnthropicThread(
	thread: PendingThread,
	model: Model<"anthropic-messages">,
	full: Params,
	reply: AssistantMessage,
	oauth: boolean,
): void {
	if (reply.responseId === undefined || reply.responseModel !== undefined) return;
	const messages = [...full.messages, ...anthropicReply(model, reply, oauth)];
	remember(thread.session, {
		count: messages.length,
		digest: fingerprint(model, full, messages),
		reply: reply.responseId,
	});
}
