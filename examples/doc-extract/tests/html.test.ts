import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToMarkdown, splitParts, tableLines } from "../src/index.ts";

const FILING = `<html><head><style>p { color: red }</style></head><body>
<p style="text-align:center">Notice of Annual Meeting &amp; Proxy</p>
<p>Intro text that is long enough to make a part of its own here.</p>
<!-- a comment -->
<p><b>Executive Compensation</b></p>
<p>We pay our people with salary, bonus &#8212; and stock.</p>
<div><span style="font-weight:700">Summary Compensation Table</span></div>
<table>
<tr><td><b>Name and Principal Position</b></td><td>Year</td><td>Salary ($)</td><td></td></tr>
<tr><td>Jane Roe<br>Chief Executive Officer</td><td>2024</td><td>$&nbsp;1,000,000</td><td>&#x2014;</td></tr>
</table>
<p><strong>Note.</strong> This line is a sentence: not a heading.</p>
<p style="font-weight:bold">Pay Ratio</p>
<p>The ratio is 120 to 1.</p>
</body></html>`;

describe("htmlToMarkdown", () => {
	it("makes a heading of each short bold line, a line of each block and table row, and drops styles and comments", () => {
		const text = htmlToMarkdown(FILING, 10);
		expect(text).toBe(
			[
				"Notice of Annual Meeting & Proxy",
				"Intro text that is long enough to make a part of its own here.",
				"",
				"## Executive Compensation",
				"We pay our people with salary, bonus — and stock.",
				"",
				"## Summary Compensation Table",
				"Name and Principal Position: Jane Roe Chief Executive Officer | Year: 2024 | Salary ($): $ 1,000,000 | —",
				"Note. This line is a sentence: not a heading.",
				"",
				"## Pay Ratio",
				"The ratio is 120 to 1.",
			].join("\n"),
		);
		expect(splitParts(text).map((part) => part.heading)).toEqual([
			"(start)",
			"Executive Compensation",
			"Summary Compensation Table",
			"Pay Ratio",
		]);
	});

	it("joins a heading to the part before it while that part is shorter than the least size of a part", () => {
		const headings = splitParts(htmlToMarkdown(FILING, 100)).map((part) => part.heading);
		expect(headings).toEqual(["(start)", "Summary Compensation Table", "Pay Ratio"]);
	});

	it("names each data cell by its header rows, through column and row spans, and leaves out spacer columns", () => {
		const table = [
			"<table>",
			'<tr><td colspan="6">Summary Compensation Table</td></tr>',
			'<tr><td></td><td></td><td colspan="2">Salary</td><td>Bonus</td><td>Total</td></tr>',
			'<tr><td>Name</td><td>Year</td><td colspan="2">($)</td><td>($)</td><td>($)</td></tr>',
			'<tr><td rowspan="2">Ann Lee<br>CEO</td><td>2025</td><td>$</td><td>900,000</td><td>—</td><td>1,000,000</td></tr>',
			"<tr><td>2024</td><td>$</td><td>850,000</td><td>(1)</td><td>950,000</td></tr>",
			"<tr><td>Bo Ray</td><td>2025</td><td></td><td>500,000</td><td>10</td><td>510,000</td></tr>",
			"</table>",
		].join("");
		expect(tableLines(table)).toEqual([
			"Name: Ann Lee CEO | Year: 2025 | Salary ($): 900,000 | Bonus ($): — | Total ($): 1,000,000",
			"Year: 2024 | Salary ($): 850,000 | Bonus ($): (1) | Total ($): 950,000",
			"Name: Bo Ray | Year: 2025 | Salary ($): 500,000 | Bonus ($): 10 | Total ($): 510,000",
		]);
	});

	it("gives a table without data rows one line for each row, its cells joined", () => {
		const table =
			"<table><tr><td>Name</td><td></td><td>Role</td></tr><tr><td>Ann</td><td></td><td>Chair</td></tr></table>";
		expect(tableLines(table)).toEqual(["Name | Role", "Ann | Chair"]);
	});

	it("makes a heading of a table's title, a short line just before the table", () => {
		const html = `<p>${"Intro words. ".repeat(10)}</p><p>Grants of Plan-Based Awards in 2025</p><p>The table below shows them.</p><table><tr><td>A</td><td>1</td><td>2</td></tr></table>`;
		expect(splitParts(htmlToMarkdown(html, 50)).map((part) => part.heading)).toEqual([
			"(start)",
			"Grants of Plan-Based Awards in 2025",
		]);
	});

	it("decodes named and numbered entities, and keeps unknown ones", () => {
		expect(decodeEntities("&lt;a&gt; &#36;5 &#x41; &bogus; &Amp;")).toBe("<a> $5 A &bogus; &");
	});
});
