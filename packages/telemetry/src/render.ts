import type { SpanAttributes, StoredSpan } from "./index.ts";

function fields(values: Readonly<SpanAttributes> = {}): string {
	return Object.entries(values)
		.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
		.join("");
}

export function renderTrace(spans: readonly StoredSpan[]): string {
	const unique = new Map<string, StoredSpan>();
	for (const span of spans) unique.set(span.id, span);
	const groups = new Map<string | undefined, StoredSpan[]>();
	for (const span of [...unique.values()].sort((a, b) => a.startedMs - b.startedMs)) {
		const parent = span.parentId !== undefined && unique.has(span.parentId) ? span.parentId : undefined;
		const group = groups.get(parent);
		if (group) group.push(span);
		else groups.set(parent, [span]);
	}
	const pending = (groups.get(undefined) ?? []).map((span) => ({ span, depth: 0 })).reverse();
	const output: string[] = [];
	for (let item = pending.pop(); item; item = pending.pop()) {
		const { span, depth } = item;
		const indent = "  ".repeat(depth);
		const failure =
			span.status.status === "error"
				? ` error${span.status.error ? ` ${span.status.error.name}: ${span.status.error.message}` : ""}`
				: "";
		output.push(`${indent}${span.name}${fields(span.attributes)} (${span.endedMs - span.startedMs}ms)${failure}`);
		for (const event of span.events)
			output.push(`${indent}  · ${event.name}${fields(event.attributes)} (+${event.timeMs}ms)`);
		for (const link of span.links)
			output.push(`${indent}  → link trace ${link.traceId} span ${link.spanId}${fields(link.attributes)}`);
		const children = groups.get(span.id) ?? [];
		for (let index = children.length - 1; index >= 0; index--)
			pending.push({ span: children[index]!, depth: depth + 1 });
	}
	return output.join("\n");
}
