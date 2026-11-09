import type { SpanAttributes, StoredSpan } from "./index.ts";

function text(value: string): string {
	return value.replace(
		/[\u0000-\u001f\u007f-\u009f]/g,
		(control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function milliseconds(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function fields(values: Readonly<SpanAttributes> = {}): string {
	return Object.entries(values)
		.map(([key, value]) => ` ${text(key)}=${JSON.stringify(value)}`)
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
				? ` error${span.status.error ? ` ${text(span.status.error.name)}: ${text(span.status.error.message)}` : ""}`
				: "";
		output.push(
			`${indent}${text(span.name)}${fields(span.attributes)} (${milliseconds(span.endedMs - span.startedMs)}ms)${failure}`,
		);
		for (const event of span.events)
			output.push(`${indent}  · ${text(event.name)}${fields(event.attributes)} (+${milliseconds(event.timeMs)}ms)`);
		for (const link of span.links)
			output.push(`${indent}  → link trace ${text(link.traceId)} span ${text(link.spanId)}${fields(link.attributes)}`);
		const children = groups.get(span.id) ?? [];
		for (let index = children.length - 1; index >= 0; index--)
			pending.push({ span: children[index]!, depth: depth + 1 });
	}
	return output.join("\n");
}
