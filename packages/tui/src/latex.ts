import { visibleWidth } from "./utils.ts";
function pairs(text: string): Record<string, string> {
	return Object.fromEntries(
		text
			.split(/\s+/)
			.filter(Boolean)
			.map((pair) => {
				const at = pair.indexOf(":");
				return [pair.slice(0, at), pair.slice(at + 1)];
			}),
	);
}
const symbols =
	pairs(`alpha:α beta:β gamma:γ delta:δ epsilon:ϵ varepsilon:ε zeta:ζ eta:η theta:θ vartheta:ϑ iota:ι kappa:κ varkappa:ϰ lambda:λ mu:μ nu:ν xi:ξ pi:π varpi:ϖ rho:ρ varrho:ϱ sigma:σ varsigma:ς tau:τ upsilon:υ phi:ϕ varphi:φ chi:χ psi:ψ omega:ω
Gamma:Γ Delta:Δ Theta:Θ Lambda:Λ Xi:Ξ Pi:Π Sigma:Σ Upsilon:Υ Phi:Φ Psi:Ψ Omega:Ω
pm:± mp:∓ times:× div:÷ cdot:· ast:∗ star:⋆ circ:∘ bullet:• oplus:⊕ ominus:⊖ otimes:⊗ oslash:⊘ odot:⊙ bigcirc:○ dagger:† ddagger:‡ amalg:⨿ uplus:⊎ sqcap:⊓ sqcup:⊔ bowtie:⋈ Join:⋈ ltimes:⋉ rtimes:⋊ leftouterjoin:⟕ rightouterjoin:⟖ fullouterjoin:⟗ triangleleft:◁ triangleright:▷ wr:≀ cap:∩ cup:∪ bigcap:⋂ bigcup:⋃ bigwedge:⋀ bigvee:⋁ bigsqcup:⨆ biguplus:⨄ bigoplus:⨁ bigotimes:⨂ bigodot:⨀ setminus:∖ in:∈ notin:∉ ni:∋ subset:⊂ supset:⊃ subseteq:⊆ supseteq:⊇ sqsubset:⊏ sqsupset:⊐ sqsubseteq:⊑ sqsupseteq:⊒ prec:≺ preceq:≼ succ:≻ succeq:≽ ll:≪ gg:≫ le:≤ leq:≤ leqslant:≤ ge:≥ geq:≥ geqslant:≥ ne:≠ neq:≠ equiv:≡ approx:≈ sim:∼ simeq:≃ cong:≅ asymp:≍ doteq:≐ propto:∝ parallel:∥ perp:⊥ mid:∣ vdash:⊢ dashv:⊣ models:⊨ Vdash:⊩ Vvdash:⊪ nvdash:⊬ nvDash:⊭ forall:∀ exists:∃ nexists:∄ neg:¬ land:∧ wedge:∧ lor:∨ vee:∨
to:→ rightarrow:→ longrightarrow:→ leftarrow:← longleftarrow:← gets:← leftrightarrow:↔ longleftrightarrow:↔ hookleftarrow:↩ hookrightarrow:↪ twoheadleftarrow:↞ twoheadrightarrow:↠ leftharpoonup:↼ leftharpoondown:↽ rightharpoonup:⇀ rightharpoondown:⇁ rightleftharpoons:⇌ leftrightharpoons:⇋ nearrow:↗ searrow:↘ swarrow:↙ nwarrow:↖ rightsquigarrow:⇝ leadsto:⇝ Rightarrow:⇒ Longrightarrow:⇒ Leftarrow:⇐ Longleftarrow:⇐ Leftrightarrow:⇔ Longleftrightarrow:⇔ implies:⇒ iff:⇔ mapsto:↦ longmapsto:↦ uparrow:↑ downarrow:↓
partial:∂ nabla:∇ int:∫ iint:∬ iiint:∭ oint:∮ sum:∑ prod:∏ coprod:∐ infty:∞ emptyset:∅ varnothing:∅ angle:∠ therefore:∴ because:∵ aleph:ℵ beth:ℶ gimel:ℷ daleth:ℸ top:⊤ bot:⊥ triangle:△ square:□ lozenge:◊ checkmark:✓ complement:∁ wp:℘ prime:′ ldots:… dots:… cdots:⋯ vdots:⋮ ddots:⋱ ell:ℓ hbar:ℏ Im:ℑ Re:ℜ langle:⟨ rangle:⟩ vert:| lvert:| rvert:| Vert:‖ lVert:‖ rVert:‖ lbrace:{ rbrace:} backslash:\\ lfloor:⌊ rfloor:⌋ lceil:⌈ rceil:⌉ colon::`);
const set = (text: string) => new Set(text.split(" "));
const named = set(
	"arccos arcsin arctan arg cos cosh cot coth csc deg det dim exp gcd hom inf ker lg lim liminf limsup ln log max min Pr sec sin sinh sup tan tanh",
);
const limits = set("argmax argmin inf injlim lim liminf limsup max min projlim sup");
const displayLimits = set(
	"bigcap bigcup bigodot bigoplus bigotimes bigsqcup biguplus bigvee bigwedge coprod int iint iiint oint prod sum",
);
const relations = set(
	"Leftarrow Leftrightarrow Longleftarrow Longleftrightarrow Longrightarrow Rightarrow Join Vdash Vvdash approx asymp bowtie cong dashv fullouterjoin doteq downarrow equiv ge geq geqslant gets gg hookleftarrow hookrightarrow iff implies in leadsto le leftarrow leftharpoondown leftharpoonup leftrightarrow leftrightharpoons leftouterjoin leq leqslant ll longleftarrow longleftrightarrow longmapsto longrightarrow ltimes mapsto mid models ne nearrow neq ni notin nvdash nvDash nwarrow parallel perp prec preceq propto rightharpoondown rightharpoonup rightleftharpoons rightouterjoin rightarrow rightsquigarrow rtimes searrow sim simeq sqsubset sqsubseteq sqsupset sqsupseteq subset subseteq succ succeq supset supseteq swarrow to triangleleft triangleright twoheadleftarrow twoheadrightarrow uparrow vdash",
);
const negated = pairs(
	"<:≮ >:≯ =:≠ ∈:∉ ∋:∌ ∣:∤ ∥:∦ ∼:≁ ≃:≄ ≅:≇ ≈:≉ ≡:≢ ≤:≰ ≥:≱ ≺:⊀ ≻:⊁ ⊂:⊄ ⊃:⊅ ⊆:⊈ ⊇:⊉ ⊢:⊬ ⊨:⊭ ↔:↮ ←:↚ →:↛ ⇒:⇏ ⇐:⇍ ⇔:⇎ ≼:⋠ ≽:⋡",
);
const blackboard = pairs("C:ℂ H:ℍ N:ℕ P:ℙ Q:ℚ R:ℝ Z:ℤ");
const superscript = pairs(
	"0:⁰ 1:¹ 2:² 3:³ 4:⁴ 5:⁵ 6:⁶ 7:⁷ 8:⁸ 9:⁹ +:⁺ -:⁻ =:⁼ (:⁽ ):⁾ a:ᵃ b:ᵇ c:ᶜ d:ᵈ e:ᵉ f:ᶠ g:ᵍ h:ʰ i:ⁱ j:ʲ k:ᵏ l:ˡ m:ᵐ n:ⁿ o:ᵒ p:ᵖ r:ʳ s:ˢ t:ᵗ u:ᵘ v:ᵛ w:ʷ x:ˣ y:ʸ z:ᶻ",
);
const subscript = pairs(
	"0:₀ 1:₁ 2:₂ 3:₃ 4:₄ 5:₅ 6:₆ 7:₇ 8:₈ 9:₉ +:₊ -:₋ =:₌ (:₍ ):₎ a:ₐ e:ₑ h:ₕ i:ᵢ j:ⱼ k:ₖ l:ₗ m:ₘ n:ₙ o:ₒ p:ₚ r:ᵣ s:ₛ t:ₜ u:ᵤ v:ᵥ x:ₓ",
);
const accents = pairs(
	"acute:́ bar:̅ breve:̆ check:̌ ddot:̈ dot:̇ grave:̀ hat:̂ mathring:̊ overleftarrow:⃖ overleftrightarrow:⃡ overline:̅ overrightarrow:⃗ tilde:̃ underline:̲ vec:⃗ widehat:̂ widetilde:̃",
);
const spacing = set(", : ; > enspace enskip medspace quad qquad thickspace thinspace");
spacing.add(" ");
const negative = set("! negmedspace negthickspace negthinspace"),
	fonts = set("bf cal it rm sf sl tt");
const ignored = set("displaystyle limits nolimits scriptstyle scriptscriptstyle textstyle");
const sizes = set("big Big bigg Bigg bigl Bigl biggl Biggl bigr Bigr biggr Biggr");
const wrappers = set(
	"emph mathcal mathbf mathfrak mathit mathrm mathnormal mathscr mathsf mathtt mathup mbox overbrace pmb smash substack text textbf textit textmd textnormal textrm textsc textsf textsl texttt textup underbrace bm boldsymbol",
);
const OPEN = "\u{f0000}",
	CLOSE = "\u{f0001}",
	SPACE = "\u{f0002}",
	NAME_OPEN = "\u{f0004}",
	NAME_CLOSE = "\u{f0005}";
const markers = /\u{f0000}(\d+)\u{f0001}/gu;
const scriptValue = (value: string) => value.trim().replace(/\s*([=+-])\s*/g, "$1");
function unicodeScript(value: string, lower: boolean): string | undefined {
	const table = lower ? subscript : superscript;
	let result = "";
	for (const char of scriptValue(value)) {
		if (table[char] === undefined) return;
		result += table[char];
	}
	return result;
}
function script(value: string, lower: boolean): string {
	value = scriptValue(value);
	const unicode = unicodeScript(value, lower);
	return (
		unicode ??
		(lower ? "_" : "^") + ([...value].length === 1 || (lower && /^[A-Za-z]+$/.test(value)) ? value : `(${value})`)
	);
}
function normalize(value: string): string {
	return value
		.replace(/(?<=[\p{L}\p{N})\]}\u{f0001}])\u{f0004}/gu, " ")
		.replaceAll(NAME_OPEN, "")
		.replace(/\u{f0005}(?=[\p{L}\p{N}√\u{f0000}])/gu, " ")
		.replaceAll(NAME_CLOSE, "")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line, index, lines) => line || (index > 0 && index < lines.length - 1))
		.join("\n")
		.trim();
}
type Node =
	| { type: "fraction"; numerator: string; denominator: string }
	| { type: "operator"; operator: string; lower?: string; upper?: string }
	| { type: "script"; lower?: string; upper?: string }
	| { type: "matrix"; lines: string[]; baseline: number };
type Layout = { lines: string[]; width: number; baseline: number };
const pad = (line: string, width: number, center = false) => {
	const count = Math.max(0, width - visibleWidth(line)),
		left = center ? Math.floor(count / 2) : 0;
	return " ".repeat(left) + line + " ".repeat(count - left);
};
function joinLayouts(parts: Layout[]): Layout {
	if (!parts.length) return { lines: [""], width: 0, baseline: 0 };
	const baseline = Math.max(...parts.map((part) => part.baseline)),
		below = Math.max(...parts.map((part) => part.lines.length - part.baseline - 1)),
		lines: string[] = [];
	for (let row = 0; row <= baseline + below; row++)
		lines.push(
			parts
				.map((part) => {
					const at = row - baseline + part.baseline;
					return at >= 0 && at < part.lines.length ? pad(part.lines[at] ?? "", part.width) : " ".repeat(part.width);
				})
				.join("")
				.trimEnd(),
		);
	return { lines, width: parts.reduce((sum, part) => sum + part.width, 0), baseline };
}
function nodeLayout(node: Node, nodes: Node[]): Layout {
	if (node.type === "matrix") {
		const width = Math.max(0, ...node.lines.map(visibleWidth));
		return { lines: node.lines.map((line) => pad(line, width)), width, baseline: node.baseline };
	}
	if (node.type === "fraction") {
		const top = layout(node.numerator, nodes),
			bottom = layout(node.denominator, nodes),
			content = Math.max(top.width, bottom.width, 1),
			width = content + 2;
		return {
			lines: [
				...top.lines.map((line) => pad(line, width, true)),
				` ${"─".repeat(content)} `,
				...bottom.lines.map((line) => pad(line, width, true)),
			],
			width,
			baseline: top.lines.length,
		};
	}
	if (node.type === "operator") {
		const width = Math.max(
			visibleWidth(node.operator),
			node.lower === undefined ? 0 : visibleWidth(node.lower),
			node.upper === undefined ? 0 : visibleWidth(node.upper),
		);
		return {
			lines: [
				...(node.upper === undefined ? [] : [pad(node.upper, width, true) + " "]),
				pad(node.operator, width, true) + " ",
				...(node.lower === undefined ? [] : [pad(node.lower, width, true) + " "]),
			],
			width: width + 1,
			baseline: node.upper === undefined ? 0 : 1,
		};
	}
	const upper = node.upper === undefined ? undefined : layout(node.upper, nodes),
		lower = node.lower === undefined ? undefined : layout(node.lower, nodes),
		width = Math.max(upper?.width ?? 0, lower?.width ?? 0);
	return {
		lines: [
			...(upper?.lines.map((line) => pad(line, width)) ?? []),
			" ".repeat(width),
			...(lower?.lines.map((line) => pad(line, width)) ?? []),
		],
		width,
		baseline: upper?.lines.length ?? 0,
	};
}
function layout(text: string, nodes: Node[]): Layout {
	const lines: string[] = [];
	let baseline = 0;
	for (const source of text.split("\n")) {
		const parts: Layout[] = [];
		let offset = 0,
			previous: Node | undefined;
		for (const match of source.matchAll(markers)) {
			const node = nodes[Number(match[1])];
			if (!node) continue;
			if (match.index > offset) {
				const slice = source.slice(offset, match.index),
					plain = (previous ? slice.trimStart() : slice).trimEnd(),
					leading = previous?.type === "matrix" && /^\s/.test(slice),
					trailing = node.type === "matrix" && /\s$/.test(slice),
					value = plain ? (leading ? " " : "") + plain + (trailing ? " " : "") : leading || trailing ? " " : "";
				parts.push({ lines: [value], width: visibleWidth(value), baseline: 0 });
			}
			parts.push(nodeLayout(node, nodes));
			offset = match.index + match[0].length;
			previous = node;
		}
		if (offset < source.length) {
			const slice = source.slice(offset),
				plain = previous ? slice.trimStart() : slice,
				value = previous?.type === "matrix" && /^\s/.test(slice) ? " " + plain : plain;
			parts.push({ lines: [value], width: visibleWidth(value), baseline: 0 });
		}
		const row = joinLayouts(parts);
		if (!lines.length) baseline = row.baseline;
		lines.push(...row.lines);
	}
	return { lines, width: Math.max(0, ...lines.map(visibleWidth)), baseline };
}
class Parser {
	readonly #source: string;
	readonly #nodes: Node[];
	readonly #display: boolean;
	#position = 0;
	#valid = true;
	#stack = true;
	#depth = 0;
	constructor(source: string, nodes: Node[], display: boolean) {
		this.#source = source;
		this.#nodes = nodes;
		this.#display = display;
	}
	render(): string | undefined {
		const value = this.sequence();
		return this.#valid && this.#position === this.#source.length ? normalize(value) : undefined;
	}
	private mark(node: Node): string {
		const index = this.#nodes.push(node) - 1;
		return OPEN + index + CLOSE;
	}
	private sequence(end?: string): string {
		let result = "";
		while (this.#position < this.#source.length) {
			const char = this.#source[this.#position]!;
			if (end && char === end) {
				this.#position++;
				return result;
			}
			if (char === "}") {
				this.#valid = false;
				return result;
			}
			if (char === "{") {
				this.#position++;
				result += this.sequence("}");
				continue;
			}
			if (char === "\\") {
				const value = this.command();
				if (value === "\0") {
					result = result.trimEnd();
					if (result.endsWith(NAME_CLOSE)) result = result.slice(0, -NAME_CLOSE.length);
				} else result += value;
				continue;
			}
			if (char === "^" || char === "_") {
				this.#position++;
				result = result.trimEnd();
				const value = this.scripts(char);
				result = result.endsWith(NAME_CLOSE)
					? result.slice(0, -NAME_CLOSE.length) + value + NAME_CLOSE
					: result + value;
				continue;
			}
			if (/\s/.test(char)) {
				while (this.#position < this.#source.length && /\s/.test(this.#source[this.#position]!)) this.#position++;
				result += " ";
				continue;
			}
			if ("=<>".includes(char)) {
				result = result.trimEnd() + ` ${char} `;
				this.#position++;
				continue;
			}
			if (char === "&") {
				this.#position++;
				continue;
			}
			if (char === "~") {
				this.#position++;
				result += " ";
				continue;
			}
			if (char === ".") {
				const match = /\u{f0000}(\d+)\u{f0001}$/u.exec(result),
					node = match ? this.#nodes[Number(match[1])] : undefined;
				if (node?.type === "matrix") {
					const index = node.lines.length - 1;
					node.lines[index] = (node.lines[index] ?? "") + char;
					this.#position++;
					continue;
				}
			}
			result += char;
			this.#position++;
		}
		if (end) this.#valid = false;
		return result;
	}
	private scripts(first: "^" | "_"): string {
		const values: { lower?: string; upper?: string } = {},
			order: ("lower" | "upper")[] = [];
		const read = (marker: string) => {
			const key = marker === "_" ? "lower" : "upper";
			this.#depth++;
			try {
				values[key] = this.argument(false);
			} finally {
				this.#depth--;
			}
			order.push(key);
		};
		read(first);
		let next = this.#position;
		while (next < this.#source.length && /\s/.test(this.#source[next]!)) next++;
		const second = this.#source[next];
		if ((second === "^" || second === "_") && second !== first) {
			this.#position = next + 1;
			read(second);
		}
		const lower = values.lower === undefined ? undefined : unicodeScript(values.lower, true),
			upper = values.upper === undefined ? undefined : unicodeScript(values.upper, false);
		const suitable = ![values.lower, values.upper].some(
			(value) =>
				value !== undefined &&
				(value.includes("/") || (!value.includes(OPEN) && [...value].length > 1 && !/[A-Z*∗]/.test(value))),
		);
		if (
			this.#display &&
			suitable &&
			(this.#depth > 0 ||
				(values.lower !== undefined && lower === undefined) ||
				(values.upper !== undefined && upper === undefined))
		)
			return this.mark({
				type: "script",
				lower: values.lower === undefined ? undefined : normalize(values.lower),
				upper: values.upper === undefined ? undefined : normalize(values.upper),
			});
		return order
			.map((key) =>
				key === "lower" ? (lower ?? script(values.lower ?? "", true)) : (upper ?? script(values.upper ?? "", false)),
			)
			.join("");
	}
	private argument(stack = true): string {
		const previous = this.#stack;
		this.#stack = previous && stack;
		while (this.#position < this.#source.length && /\s/.test(this.#source[this.#position]!)) this.#position++;
		let result: string;
		if (this.#position >= this.#source.length) {
			this.#valid = false;
			result = "";
		} else if (this.#source[this.#position] === "{") {
			this.#position++;
			result = this.sequence("}");
		} else if (this.#source[this.#position] === "\\") result = this.command();
		else result = this.#source[this.#position++]!;
		this.#stack = previous;
		return result;
	}
	private raw(): string | undefined {
		while (/[ \t]/.test(this.#source[this.#position] ?? "") && this.#position < this.#source.length) this.#position++;
		if (this.#source[this.#position] !== "{") {
			this.#valid = false;
			return;
		}
		const start = ++this.#position;
		let depth = 1;
		while (this.#position < this.#source.length) {
			const char = this.#source[this.#position];
			if (char === "\\") {
				this.#position += 2;
				continue;
			}
			if (char === "{") depth++;
			if (char === "}") depth--;
			if (depth === 0) return this.#source.slice(start, this.#position++);
			this.#position++;
		}
		this.#valid = false;
		return;
	}
	private nested(source: string, stack = true): string {
		const result = new Parser(source, this.#nodes, this.#display && stack).render();
		if (result === undefined) {
			this.#valid = false;
			return source;
		}
		return result;
	}
	private optional(): string | undefined {
		while (this.#position < this.#source.length && /[ \t]/.test(this.#source[this.#position]!)) this.#position++;
		if (this.#source[this.#position] !== "[") return;
		const end = this.#source.indexOf("]", this.#position + 1);
		if (end < 0) {
			this.#valid = false;
			return;
		}
		const value = this.#source.slice(this.#position + 1, end);
		this.#position = end + 1;
		return this.nested(value);
	}
	private command(): string {
		this.#position++;
		if (this.#position >= this.#source.length) {
			this.#valid = false;
			return "";
		}
		const start = this.#position,
			first = this.#source[start]!;
		let name: string;
		if (first === "\n" || first === "\r") {
			this.#position++;
			if (first === "\r" && this.#source[this.#position] === "\n") this.#position++;
			return " ";
		}
		if (/[A-Za-z]/.test(first)) {
			while (this.#position < this.#source.length && /[A-Za-z]/.test(this.#source[this.#position]!)) this.#position++;
			name = this.#source.slice(start, this.#position);
		} else {
			name = first;
			this.#position++;
		}
		if (name === "\\") return "\n";
		if (spacing.has(name)) return " ";
		if (negative.has(name)) return "\0";
		if (fonts.has(name)) {
			while (this.#position < this.#source.length && /\s/.test(this.#source[this.#position]!)) this.#position++;
			return "";
		}
		if (ignored.has(name)) return "";
		if ("{}$%#_&".includes(name)) return name;
		if (name === "|") return "‖";
		if (name === "not") {
			const value = this.argument(false).trim(),
				known = negated[value];
			if (known !== undefined) return ` ${known} `;
			const chars = [...value];
			if (!chars.length) {
				this.#valid = false;
				return "";
			}
			return ` ${chars[0]}̸${chars.slice(1).join("")} `;
		}
		if (limits.has(name)) return this.operator(name, true, true, true);
		const symbol = symbols[name];
		if (symbol !== undefined) {
			if (displayLimits.has(name)) return this.operator(symbol, false, true);
			return name === "cdot" || name === "times" || relations.has(name) ? ` ${symbol} ` : symbol;
		}
		if (named.has(name)) return NAME_OPEN + name + NAME_CLOSE;
		if (sizes.has(name)) return "";
		if (name === "left" || name === "right" || name === "middle") {
			if (this.#source[this.#position] === ".") this.#position++;
			return "";
		}
		if (name === "frac" || name === "dfrac" || name === "tfrac") {
			const stack = this.#display && this.#stack && name !== "tfrac",
				top = this.argument(!stack),
				bottom = this.argument(!stack);
			if (stack) return this.mark({ type: "fraction", numerator: normalize(top), denominator: normalize(bottom) });
			const a = top.trim(),
				b = bottom.trim();
			return (
				(/^[\p{L}\p{N}.]+$/u.test(a) ? a : `(${a})`) +
				"/" +
				(/^[\p{N}.]+$/u.test(b) || [...b].length === 1 ? b : `(${b})`)
			);
		}
		if (name === "sqrt") {
			const degree = this.optional()?.trim(),
				value = this.argument().trim(),
				root = degree === "3" ? "∛" : degree === "4" ? "∜" : "√",
				body = /^[\p{L}\p{N}.]+$/u.test(value) ? root + value : root + `(${value})`;
			return degree === undefined || ["2", "3", "4"].includes(degree) ? body : script(degree, false) + body;
		}
		if (name === "boxed" || name === "fbox") return `[${this.argument().trim()}]`;
		if (["binom", "dbinom", "tbinom"].includes(name)) return `(${this.argument()} choose ${this.argument()})`;
		const accent = accents[name];
		if (accent !== undefined) {
			const value = this.argument();
			return [...value].length === 1 ? value + accent : `${name}(${value})`;
		}
		if (name === "mathbb") return [...this.argument()].map((char) => blackboard[char] ?? char).join("");
		if (name === "operatorname") {
			const starred = this.#source[this.#position] === "*";
			if (starred) this.#position++;
			return this.operator(normalize(this.argument()).trim(), true, starred, true);
		}
		if (name === "mod" || name === "bmod") return " mod ";
		if (name === "pmod" || name === "pod") return ` (${name === "pmod" ? "mod " : ""}${this.argument().trim()})`;
		if (name === "overset" || name === "stackrel" || name === "underset") {
			const value = this.argument(),
				base = this.argument().trim();
			return base + script(value, name === "underset");
		}
		if (wrappers.has(name)) {
			const value = this.argument();
			return name.startsWith("text") || name === "mbox" ? value : value.trim();
		}
		if (name === "begin") return this.environment();
		this.#valid = false;
		return name === "end" ? "" : "\\" + name;
	}
	private operator(name: string, brackets: boolean, display: boolean, spaced = false): string {
		let offset = this.#position;
		while (offset < this.#source.length && /[ \t]/.test(this.#source[offset]!)) offset++;
		const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.#source.slice(offset));
		if (modifier) {
			display = modifier[1] === "limits";
			this.#position = offset + modifier[0].length;
		}
		let lower: string | undefined, upper: string | undefined;
		while (true) {
			let next = this.#position;
			while (next < this.#source.length && /[ \t]/.test(this.#source[next]!)) next++;
			const kind = this.#source[next];
			if (kind !== "_" && kind !== "^") break;
			this.#position = next + 1;
			const value = normalize(this.argument(false)).replaceAll(" ", "");
			if (kind === "_") {
				if (lower !== undefined) this.#valid = false;
				lower = value;
			} else {
				if (upper !== undefined) this.#valid = false;
				upper = value;
			}
		}
		if (this.#display && display && (lower !== undefined || upper !== undefined))
			return this.mark({ type: "operator", operator: name, lower, upper });
		const result =
			name +
			(lower === undefined ? "" : brackets ? `[${lower}]` : script(lower, true)) +
			(upper === undefined ? "" : script(upper, false));
		return spaced ? ` ${result} ` : result;
	}
	private environment(): string {
		const name = this.raw();
		if (!name) return "";
		const marker = `\\end{${name}}`,
			end = this.#source.indexOf(marker, this.#position);
		if (end < 0) {
			this.#valid = false;
			return "";
		}
		const body = this.#source.slice(this.#position, end);
		this.#position = end + marker.length;
		if (["equation", "equation*", "displaymath"].includes(name)) return this.nested(body).trim();
		const split = (source: string) => source.split(/\\\\(?:\[[^\]\n]*\])?/);
		if (
			[
				"aligned",
				"align",
				"align*",
				"alignedat",
				"alignat",
				"alignat*",
				"gather",
				"gathered",
				"multline",
				"multline*",
				"split",
			].includes(name)
		) {
			const at = ["alignedat", "alignat", "alignat*"].includes(name),
				source = at ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			return split(source)
				.map((row) => {
					const cells = row.split("&"),
						value = at
							? Array.from({ length: Math.ceil(cells.length / 2) }, (_, index) =>
									cells.slice(index * 2, index * 2 + 2).join(""),
								).join(" ")
							: cells.join("");
					return this.nested(value).trim();
				})
				.filter(Boolean)
				.join("\n");
		}
		if (name === "cases" || name === "cases*") {
			const rows = split(body)
				.map((row) => row.split("&").map((cell) => this.nested(cell, false).trim()))
				.filter((row) => row.some(Boolean));
			const width = Math.max(0, ...rows.map((row) => visibleWidth((row[0] ?? "").replace(/,\s*$/, ""))));
			const contents = rows.map((row) => {
				const value = (row[0] ?? "").replace(/,\s*$/, ""),
					condition = row[1] ?? "";
				return condition
					? value +
							SPACE.repeat(width - visibleWidth(value)) +
							(/^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ") +
							condition
					: value;
			});
			if (contents.length <= 1) return contents.length ? "⎧ " + contents[0] : "";
			const middle = Math.floor(contents.length / 2),
				visual: (string | undefined)[] = [...contents];
			if (contents.length % 2 === 0) visual.splice(middle, 0, undefined);
			return this.mark({
				type: "matrix",
				lines: visual.map(
					(value, index) =>
						(index === 0 ? "⎧" : index === visual.length - 1 ? "⎩" : "⎨") + (value === undefined ? "" : " " + value),
				),
				baseline: middle,
			});
		}
		if (["array", "matrix", "smallmatrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"].includes(name)) {
			const source = name === "array" ? body.replace(/^\s*\{[^}]*\}/, "") : body,
				rows = split(source)
					.map((row) => row.split("&").map((cell) => this.nested(cell, false).trim()))
					.filter((row) => row.some(Boolean));
			const count = Math.max(0, ...rows.map((row) => row.length)),
				widths = Array.from({ length: count }, (_, index) =>
					Math.max(0, ...rows.map((row) => visibleWidth(row[index] ?? ""))),
				);
			let lines = rows.map((row) =>
				Array.from({ length: count }, (_, index) => {
					const value = row[index] ?? "";
					return value + SPACE.repeat(Math.max(0, widths[index]! - visibleWidth(value)));
				}).join(" │ "),
			);
			if (!["array", "matrix", "smallmatrix"].includes(name)) {
				const delimiters: Record<string, string[]> = {
					pmatrix: ["⎛", "⎞", "⎜", "⎟", "⎝", "⎠"],
					bmatrix: ["⎡", "⎤", "⎢", "⎥", "⎣", "⎦"],
					Bmatrix: ["⎧", "⎫", "⎨", "⎬", "⎩", "⎭"],
					vmatrix: ["│", "│", "│", "│", "│", "│"],
					Vmatrix: ["║", "║", "║", "║", "║", "║"],
				};
				const chars = delimiters[name]!;
				lines = lines.map((row, index) => {
					const pair = index === 0 ? 0 : index === lines.length - 1 ? 4 : 2;
					return chars[pair] + " " + row + " " + chars[pair + 1];
				});
			}
			return lines.length > 1 ? this.mark({ type: "matrix", lines, baseline: 0 }) : (lines[0] ?? "");
		}
		this.#valid = false;
		return body;
	}
}
export interface RenderLatexOptions {
	display?: boolean;
}
export function renderLatex(source: string, options: RenderLatexOptions = {}): string | undefined {
	const nodes: Node[] = [],
		text = new Parser(source, nodes, options.display === true).render();
	if (text === undefined) return;
	if (!nodes.length) return text.replaceAll(SPACE, " ");
	const lines = layout(text, nodes).lines,
		indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
	return lines
		.map((line) => line.slice(indent).trimEnd())
		.join("\n")
		.trimEnd()
		.replaceAll(SPACE, " ");
}
