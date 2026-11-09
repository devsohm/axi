export const MAX_FRAME = 64 * 1024;
const modes = new Set(["7", "25", "1000", "1002", "1004", "1006", "1049", "2004", "2026"]);
function drawing(parameters: string, command: string): boolean {
	if (parameters.length > 128) return false;
	if (command === "h" || command === "l") return parameters[0] === "?" && modes.has(parameters.slice(1));
	if (command === "m") return /^[\d;:]*$/.test(parameters) && !/\d{5}/.test(parameters);
	if (!/^[\d;]*$/.test(parameters) || /\d{5}/.test(parameters)) return false;
	if ("ABCDEFGHfd".includes(command))
		return parameters.split(";").length <= (command === "H" || command === "f" ? 2 : 1);
	if (command === "J" || command === "K") return /^[012]?$/.test(parameters);
	if (command === "r") return /^(?:\d{1,4};\d{1,4})?$/.test(parameters);
	return parameters.length === 0 && (command === "s" || command === "u");
}
export function filterOutput(output: string): string {
	if (output.length > MAX_FRAME || Buffer.byteLength(output) > MAX_FRAME)
		throw new RangeError("terminal: a frame over 64 KiB");
	let result = "",
		at = 0;
	while (at < output.length) {
		const start = at,
			code = output.charCodeAt(at++);
		if (code !== 27 && !(code >= 0x80 && code <= 0x9f)) {
			if ([9, 10, 13].includes(code) || (code >= 32 && code !== 127)) result += output[start];
			continue;
		}
		const type = code === 27 ? output[at++] : output[start];
		if (type === "[" || code === 0x9b) {
			const body = at;
			while (at < output.length && /[ -?]/.test(output[at]!)) at++;
			const command = output[at++];
			if (code === 27 && command && drawing(output.slice(body, at - 1), command)) result += output.slice(start, at);
		} else if ((type && "]PX^_".includes(type)) || [0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
			while (at < output.length) {
				const next = output.charCodeAt(at++);
				if (next === 7 || next === 0x9c) break;
				if (next === 27 && output[at] === "\\") {
					at++;
					break;
				}
			}
		} else {
			while (at <= output.length && /[ -/]/.test(output[at - 1] ?? "")) at++;
		}
	}
	return result;
}
