import {
	type Component,
	dispatchMouseEvent,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TuiMouseDispatchResult,
} from "../tui.ts";

export type MouseRegionHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
export class MouseRegion implements Component {
	readonly #child: Component;
	readonly #handler: MouseRegionHandler;
	constructor(child: Component, onMouse: MouseRegionHandler) {
		this.#child = child;
		this.#handler = onMouse;
	}
	render(width: number): string[] {
		return this.#child.render(width);
	}
	invalidate(): void {
		this.#child.invalidate();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
		return dispatchMouseEvent(this.#child, event) ?? this.#handler(event);
	}
}
