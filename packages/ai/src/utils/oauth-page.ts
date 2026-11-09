function escape(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
function page(success: boolean, message: string, details?: string): string {
	const title = success ? "Authentication successful" : "Authentication failed";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111318;color:#f5f5f5;font:16px system-ui,sans-serif}main{max-width:36rem;padding:2rem;text-align:center}h1{font-size:1.7rem}p{line-height:1.6;color:#b9bec8}pre{white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;border:1px solid #414650;border-radius:.5rem;padding:1rem}svg{width:7rem;height:3rem}</style></head>
<body><main><svg viewBox="0 0 120 48" aria-label="Axi"><text x="0" y="37" font-size="42" fill="#F09082">A</text><text x="40" y="37" font-size="42" fill="#4D9ABF">X</text><text x="83" y="37" font-size="42" fill="#F1BE58">I</text></svg><h1>${title}</h1><p>${escape(message)}</p>${details ? `<pre>${escape(details)}</pre>` : ""}</main></body></html>`;
}
export function oauthSuccessHtml(message: string): string {
	return page(true, message);
}
export function oauthErrorHtml(message: string, details?: string): string {
	return page(false, message, details);
}
