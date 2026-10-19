export function toCodemodeIdentifier(name: string): string {
	let result = "";
	for (const character of name)
		result += (result.length === 0 ? /^[A-Za-z_$]$/ : /^[A-Za-z0-9_$]$/).test(character) ? character : "_";
	return result || "_";
}
