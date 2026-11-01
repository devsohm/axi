import { ProcessTerminal } from "../../src/terminal.ts";
const terminal = new ProcessTerminal();
const inputs = [];
const timeout = setTimeout(() => {
	terminal.stop();
	process.exitCode = 2;
}, 5000);
terminal.start(
	async (data) => {
		inputs.push(data);
		if (data !== "\r") return;
		const kitty = terminal.kittyProtocolActive;
		await terminal.drainInput(20, 5);
		terminal.stop();
		clearTimeout(timeout);
		process.stdout.write(
			"\nRESULT:" +
				JSON.stringify({
					inputs,
					kitty,
					raw: process.stdin.isRaw,
					tty: process.stdin.isTTY,
					size: [terminal.columns, terminal.rows],
				}) +
				"\n",
		);
	},
	() => process.stdout.write(`\nSIZE:${terminal.columns}x${terminal.rows}\n`),
);
terminal.setTitle("Axi terminal test");
process.stdout.write("\nREADY\n");
