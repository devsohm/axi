import { expect, test } from "vitest";
import { renderLatex } from "../src/latex.ts";

test.each([
	[String.raw`\sum_i`, "∑\ni"],
	[String.raw`\sum^n`, "n\n∑"],
	[String.raw`\operatorname*{argmax}_{AB}`, "argmax\n  AB"],
	[String.raw`x^A`, " A\nx"],
	[String.raw`x_B`, "x\n B"],
	[String.raw`x_B^A`, " A\nx\n B"],
	[String.raw`x^{ab}`, "xᵃᵇ"],
] satisfies [string, string][])("display math preserves the baseline for %s", (source, expected) => {
	expect(renderLatex(source, { display: true })).toBe(expected);
});

test("adjacent matrices retain aligned rows, separating text and final punctuation", () => {
	expect(renderLatex(String.raw`\begin{matrix}a\\b\end{matrix} + \begin{matrix}c\\d\end{matrix}`)).toBe("a + c\nb   d");
	expect(renderLatex(String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}.`)).toBe("⎡ a │ b ⎤\n⎣ c │ d ⎦.");
	expect(renderLatex(String.raw`\begin{Vmatrix}a\\b\\c\end{Vmatrix}`)).toBe("║ a ║\n║ b ║\n║ c ║");
});

test("empty environments, single-row cases and omitted matrix cells stay renderable", () => {
	for (const name of ["matrix", "cases", "aligned"]) {
		expect(renderLatex(`\\begin{${name}}\\end{${name}}`)).toBe("");
	}
	expect(renderLatex(String.raw`\begin{cases}x, & when positive\end{cases}`)).toBe("⎧ x when positive");
	expect(renderLatex(String.raw`\begin{array}{cc}a&b\\c\end{array}`)).toBe("a │ b\nc │  ");
});

test("name spacing, literal newlines and unknown negations preserve readable text", () => {
	expect(renderLatex(String.raw`\sin^2 x + \sin\!x`)).toBe("sin² x + sinx");
	expect(renderLatex("\\alpha\\\r\n\\beta")).toBe("α β");
	expect(renderLatex(String.raw`\not x`)).toBe("x̸");
	expect(renderLatex(String.raw`\mathbb{AQR} \pod{3}`)).toBe("Aℚℝ (3)");
	expect(renderLatex("a&b")).toBe("ab");
});

test("malformed arguments and nested environments reject the whole expression", () => {
	for (const source of [
		String.raw`x^`,
		String.raw`x_`,
		String.raw`\sum^`,
		String.raw`\begin{matrix}{a\\b\end{matrix}`,
		String.raw`\begin{array`,
		String.raw`\begin matrix`,
		String.raw`\begin{aligned}\unknown{x}\end{aligned}`,
		String.raw`\sqrt[\unknown{x}]{y}`,
	]) {
		expect(renderLatex(source), source).toBeUndefined();
	}
	expect(renderLatex(String.raw`\sqrt{y}`)).toBe("√y");
});
