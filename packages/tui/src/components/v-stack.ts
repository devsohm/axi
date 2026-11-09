import { Stack, allocateStackSizes, visibleStackEntries } from "./stack.ts";
export class VStack extends Stack {
	protected readonly layoutType = "vstack";
	override render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport),
			rendered = entries.map((entry) => entry.component.render(viewport.width));
		const heights = allocateStackSizes(
			entries,
			rendered.map((lines) => lines.length),
			undefined,
			this.gap,
		);
		const result: string[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (index) for (let row = 0; row < this.gap; row++) result.push("");
			const lines = rendered[index]!.slice(0, heights[index]);
			result.push(...lines);
			for (let row = lines.length; row < heights[index]!; row++) result.push("");
		}
		return result;
	}
}
export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
