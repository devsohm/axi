import { expect, test } from "vitest";
import { renderLatex } from "../src/latex.ts";

test("inline math composes roots, accents, scripts, operators and grouped formatting", () => {
	for (const [source, expected] of [
		["\\sqrt[3]{x} + \\sqrt[4]{y}", "∛x + ∜y"],
		["\\sqrt[5]{a+b}", "⁵√(a+b)"],
		["\\boxed{x_2} = \\binom{n}{k}", "[x₂] = (n choose k)"],
		["\\hat{x} + \\bar{yz}", "x̂ + bar(yz)"],
		["\\not\\in A \\land x\\not=2", "∉ A ∧ x ≠ 2"],
		["\\mathbb{NZ} \\text{numbers}", "ℕℤ numbers"],
		["\\operatorname{rank}(A) \\pmod{2}", "rank (A) (mod 2)"],
		["\\operatorname*{argmax}_{x} f(x)", "argmax[x] f(x)"],
		["\\sum_{i=0}^{n}i", "∑ᵢ₌₀ⁿi"],
		["\\lim_{x\\to0}\\sin x", "lim[x→0] sin x"],
		["\\overset{a}{x} + \\underset{b}{y}", "xᵃ + y_b"],
		["x^{AB}_q", "x^(AB)_q"],
		["\\left. x \\right| + \\{a\\}", "x | + {a}"],
		["{\\bf a}\\,b\\!c", "a bc"],
		["a~b\\\\c", "a b\nc"],
	])
		expect.soft(renderLatex(source!), source).toBe(expected);
});

test("matrix and alignment environments preserve rows, columns and delimiters", () => {
	expect(renderLatex("\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}")).toBe("⎛ 1 │ 2 ⎞\n⎝ 3 │ 4 ⎠");
	expect(renderLatex("\\begin{matrix}x&y\\\\long&z\\end{matrix}")).toBe("x    │ y\nlong │ z");
	expect(renderLatex("\\begin{aligned}a&=b\\\\c&=d\\end{aligned}")).toBe("a = b\nc = d");
	expect(renderLatex("\\begin{alignat}{2}a&=b&c&=d\\end{alignat}")).toBe("a = b c = d");
	expect(renderLatex("\\begin{equation}x^2 = y\\end{equation}")).toBe("x² = y");
	expect(renderLatex("\\begin{cases}x&x>0\\\\0&otherwise\\end{cases}")).toBe("⎧ x if x > 0\n⎨\n⎩ 0 otherwise");
});

test("display equations stack fractions and operator limits around their baseline", () => {
	expect(renderLatex("\\frac{ab}{c}", { display: true })).toBe("ab\n──\nc");
	expect(renderLatex("\\sum_{i=1}^{n} x", { display: true })).toBe(" n\n ∑  x\ni=1");
	expect(renderLatex("\\sum\\nolimits_{i=1}^{n}x", { display: true })).toBe("∑ᵢ₌₁ⁿx");
	expect(renderLatex("\\tfrac{a}{b}", { display: true })).toBe("a/b");
});

test("malformed and unsupported math returns no layout rather than partial output", () => {
	for (const source of [
		"{x",
		"x}",
		"\\",
		"\\frac{a}",
		"\\sqrt[3{x}",
		"\\not{}",
		"\\begin",
		"\\begin{matrix}x",
		"\\begin{unknown}x\\end{unknown}",
		"\\sum_{a}_{b}x",
		"\\sum^{a}^{b}x",
		"\\end{matrix}",
	])
		expect(renderLatex(source)).toBeUndefined();
	expect(renderLatex("x+1")).toBe("x+1");
});

test("nested operator limits preserve their rendered marker characters", () => {
	expect(renderLatex("\\sum_{x}^{x_{i_j}} x", { display: true })).toBe("x\u{f0000}1\u{f0001}\n ∑   x\n x");
});
