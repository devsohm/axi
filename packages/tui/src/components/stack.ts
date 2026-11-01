import { LAYOUT_NODE, type LayoutViewport, type StackLayoutEntry, type StackLayoutNode } from "../layout-node.ts";
import { Container, type Component } from "../tui.ts";
export interface StackEntryOptions {
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}
export interface StackEntry extends StackEntryOptions {
	component: Component;
}
export type StackChild = Component | StackEntry;
export interface StackOptions {
	gap?: number;
	align?: "stretch" | "start" | "center" | "end";
}
function size(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}
export abstract class Stack extends Container {
	protected readonly entries: StackLayoutEntry[] = [];
	protected readonly gap: number;
	protected readonly align: NonNullable<StackOptions["align"]>;
	protected abstract readonly layoutType: "vstack" | "hstack";
	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super();
		this.gap = size(options.gap, 0);
		this.align = options.align ?? "stretch";
		for (const child of children) {
			if ("render" in child) this.addChild(child);
			else this.addChild(child.component, child);
		}
	}
	override addChild(component: Component, options: StackEntryOptions = {}): void {
		super.addChild(component);
		const entry: StackLayoutEntry = { component };
		if (options.basis !== undefined) entry.basis = options.basis;
		if (options.visible !== undefined) entry.visible = options.visible;
		if (options.grow !== undefined) entry.grow = size(options.grow, 0);
		if (options.shrink !== undefined) entry.shrink = size(options.shrink, 1);
		if (options.minSize !== undefined) entry.minSize = size(options.minSize, 0);
		if (options.maxSize !== undefined) entry.maxSize = size(options.maxSize, Number.MAX_SAFE_INTEGER);
		this.entries.push(entry);
	}
	override removeChild(component: Component): void {
		super.removeChild(component);
		const index = this.entries.findIndex((entry) => entry.component === component);
		if (index >= 0) this.entries.splice(index, 1);
	}
	override clear(): void {
		super.clear();
		this.entries.length = 0;
	}
	[LAYOUT_NODE](): StackLayoutNode {
		return { type: this.layoutType, entries: this.entries, gap: this.gap, align: this.align };
	}
}
export function visibleStackEntries(
	entries: readonly StackLayoutEntry[],
	viewport: LayoutViewport,
): StackLayoutEntry[] {
	return entries.filter((entry) => entry.visible?.(viewport) ?? true);
}
export function allocateStackSizes(
	entries: readonly StackLayoutEntry[],
	intrinsicSizes: readonly number[],
	availableSize: number | undefined,
	gap: number,
): number[] {
	const sizes = entries.map((entry, index) => {
		const base = entry.basis === undefined || entry.basis === "auto" ? (intrinsicSizes[index] ?? 0) : entry.basis;
		const minimum = Math.max(0, Math.floor(entry.minSize ?? 0));
		return Math.max(
			minimum,
			Math.min(Math.max(minimum, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER)), Math.max(0, Math.floor(base))),
		);
	});
	if (availableSize === undefined) return sizes;
	const target = Math.max(0, Math.floor(availableSize) - Math.max(0, entries.length - 1) * gap);
	const total = sizes.reduce((a, b) => a + b, 0),
		growing = target > total;
	let remaining = Math.abs(target - total);
	while (remaining > 0) {
		const active = entries
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry, index }) =>
				growing
					? (entry.grow ?? 0) > 0 && sizes[index]! < (entry.maxSize ?? Number.MAX_SAFE_INTEGER)
					: (entry.shrink ?? 1) > 0 && sizes[index]! > (entry.minSize ?? 0),
			);
		if (!active.length) break;
		const weight = ({ entry, index }: { entry: StackLayoutEntry; index: number }) =>
			growing ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, sizes[index]!);
		const sum = active.reduce((value, item) => value + weight(item), 0);
		let moved = 0;
		for (const item of active) {
			const current = sizes[item.index]!;
			const capacity = growing
				? (item.entry.maxSize ?? Number.MAX_SAFE_INTEGER) - current
				: current - (item.entry.minSize ?? 0);
			const amount = Math.min(remaining, capacity, Math.max(1, Math.floor((remaining * weight(item)) / sum)));
			if (amount <= 0) continue;
			sizes[item.index] = current + (growing ? amount : -amount);
			remaining -= amount;
			moved += amount;
		}
		if (!moved) break;
	}
	return sizes;
}
