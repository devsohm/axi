# Axi TUI

Independent terminal UI library for scrollback and fullscreen applications.

The package provides terminal adapters, input framing, configurable keybindings, Unicode text measurement, editing, completion, layout and reusable components. Scrollback and fullscreen renderers support scrolling, transcript search, overlays, mouse selection and image placement.

The multiline editor supports history, undo, paste markers and mouse positioning. Markdown includes tables, syntax-highlighting callbacks and mathematical notation. Color utilities provide ANSI styles and perceptual color conversion. Native clipboard and modifier helpers support Linux, macOS and Windows; see [native helpers](native/README.md). The verification workflow runs on both architectures of these operating systems. Applications supply their chat interface. Native checks do not establish visual appearance in every terminal application.

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
