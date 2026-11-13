import { appendFileSync } from "node:fs";
import {
	Editor,
	isKeyRelease,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@axi/tui";

const [mode, report] = process.argv.slice(2);
const terminal = new ProcessTerminal();
const ui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
const plain = (text) => text;
const editor = new Editor(ui, {
	borderColor: plain,
	selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
});
const body = new Text("Axi terminal acceptance\nshort output", 0, 0);
const listeners = [process.stdin.listenerCount("data"), process.stdout.listenerCount("resize")];
const record = (event, fields = {}) => appendFileSync(report, JSON.stringify({ event, ...fields }) + "\n");
const resized = () => record("resized", { columns: terminal.columns, rows: terminal.rows });
let overlay,
	stream,
	expanded = false,
	chunk = 0;
const deadline = setTimeout(() => finish(2), 15000);
function finish(code) {
	clearTimeout(deadline);
	clearInterval(stream);
	process.stdout.removeListener("resize", resized);
	ui.stop();
	record("closed", {
		code,
		raw: process.stdin.isRaw,
		listeners: [process.stdin.listenerCount("data"), process.stdout.listenerCount("resize")],
		beforeListeners: listeners,
	});
	process.exitCode = code;
}
editor.onSubmit = (text) => record("submitted", { text });
if (mode === "fullscreen") {
	ui.setLayoutRoot(
		new VStack([
			{ component: new ScrollView(body, { primary: true, follow: "end" }), basis: 0, grow: 1 },
			{ component: editor, basis: 3, shrink: 0 },
		]),
	);
} else {
	ui.addChild(body);
	ui.addChild(editor);
}
ui.setFocus(editor);
ui.addInputListener((data) => {
	if (isKeyRelease(data)) return { consume: true };
	if (matchesKey(data, "ctrl+c")) {
		finish(0);
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+o")) {
		if (overlay) {
			overlay.hide();
			overlay = undefined;
		} else overlay = ui.showOverlay(new Text("Overlay is open", 0, 0), { row: 1, col: 2, width: 24 });
		ui.renderNow();
		record("overlay", { visible: Boolean(overlay) });
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+t")) {
		expanded = !expanded;
		body.setText(
			expanded
				? Array.from({ length: 2000 }, (_, i) => `tool row ${i}`).join("\n")
				: "Axi terminal acceptance\nshort output",
		);
		ui.renderNow();
		record("expanded", { value: expanded });
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+s")) {
		clearInterval(stream);
		chunk = 0;
		stream = setInterval(() => {
			body.setText(`Axi terminal acceptance\n\x1b[36mstream chunk ${++chunk}\x1b[0m`);
			ui.renderNow();
			if (chunk === 30) {
				clearInterval(stream);
				record("streamed", { chunk });
			}
		}, 5);
		return { consume: true };
	}
});
ui.start();
ui.renderNow();
process.stdout.on("resize", resized);
record("ready");
