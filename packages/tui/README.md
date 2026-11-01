# Axi TUI

Independent terminal UI library for scrollback and fullscreen applications.

The current package provides a process-terminal adapter, keyboard decoding and configurable bindings, input framing, text measurement and formatting, containers, padded and truncated text, spacers, and a single-line input component. It also provides wheel acceleration, fuzzy matching and editor history helpers.

Main-screen and fullscreen renderers are available, including viewport layout, scrolling, search, overlays, mouse selection and image placement. The multiline editor supports history, undo, paste markers, completion and mouse positioning. Markdown includes tables, syntax-highlighting callbacks and mathematical notation. Color utilities provide ANSI styles and perceptual color conversion. The Linux X11 clipboard backend can be built locally; see [native helpers](native/README.md). macOS and Windows clipboard and modifier sources are included; their native runtime verification remains outstanding. There is no runnable chat interface yet.

The terminal library owns input, layout, rendering and reusable components. It has no dependency on the agent runtime.

An application connects the library to Durable through a runtime adapter. The adapter exposes current conversation values, change subscriptions and commands. The application renders messages and tools, handles commands and selects themes. Durable owns execution and persistence.

## Start a terminal

Save this as an ES module in an application that depends on `@axi/tui`, then run it with Node.js:

```js
import { matchesKey, ProcessTerminal, Text, TuiMainScreen } from "@axi/tui";

const ui = new TuiMainScreen(new ProcessTerminal());
ui.addChild(new Text("Axi terminal. Press Ctrl+C to exit.", 0, 0));
ui.addInputListener((data) => {
	if (matchesKey(data, "ctrl+c")) {
		ui.stop();
		return { consume: true };
	}
});
ui.start();
```

Use `TuiAltScreen` instead for a fullscreen viewport. See [contracts](docs/spec.md) for input, components and rendering, and [Durable integration](docs/durable-connection.md) for application ownership.

[API reference](docs/api.md)
