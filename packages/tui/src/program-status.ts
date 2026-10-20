export interface ProgramStatus {
	state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
	app?: string;
	kind?: "permission" | "question" | "auth";
	message?: string;
}
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";
export function isProgramStatusReply(sequence: string): boolean {
	return /^\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(sequence);
}
export function formatProgramStatus(status: ProgramStatus): string {
	const fields = [`state=${status.state}`];
	if (status.app !== undefined && /^[A-Za-z0-9_.+-]{1,32}$/.test(status.app)) fields.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) fields.push(`kind=${status.kind}`);
	const cleaned = (status.message ?? "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim();
	let message = "",
		bytes = 0;
	for (const char of cleaned) {
		bytes += Buffer.byteLength(char, "utf8");
		if (bytes > 2048) break;
		message += char;
	}
	if (message) fields.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
	return `\x1b]7501;${fields.join(":")}\x1b\\`;
}
