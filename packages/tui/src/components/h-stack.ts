import { compositeTuiLine } from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import { Stack, allocateStackSizes, visibleStackEntries } from "./stack.ts";
export class HStack extends Stack {
	protected readonly layoutType = "hstack";
	override render(width: number): string[] {
		const safe = Math.max(1, width),
			entries = visibleStackEntries(this.entries, { width: safe, height: Number.MAX_SAFE_INTEGER });
		if (!entries.length) return [];
		const widths = allocateStackSizes(
			entries,
			entries.map((entry) => entry.component.render(safe).reduce((max, line) => Math.max(max, visibleWidth(line)), 0)),
			safe,
			this.gap,
		);
		const rendered = entries.map((entry, index) => (widths[index] === 0 ? [] : entry.component.render(widths[index]!)));
		const height = Math.max(...rendered.map((lines) => lines.length)),
			result = Array<string>(height).fill("");
		let x = 0;
		for (let index = 0; index < entries.length; index++) {
			const lines = rendered[index]!,
				offset =
					this.align === "end"
						? height - lines.length
						: this.align === "center"
							? Math.floor((height - lines.length) / 2)
							: 0;
			for (let row = 0; row < lines.length; row++)
				result[row + offset] = compositeTuiLine(result[row + offset]!, lines[row]!, x, widths[index]!, safe);
			x += widths[index]! + this.gap;
		}
		return result;
	}
}
