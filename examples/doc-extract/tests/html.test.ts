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
				"Name and Principal Position | Year | Salary ($) |",
				"Jane Roe Chief Executive Officer | 2024 | $ 1,000,000 | —",
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

	it("keeps a table's columns: it drops spacer columns and lone currency signs, and keeps empty cells in use", () => {
		const table =
			"<table><tr><td>Name</td><td></td><td>Salary</td><td>Bonus</td></tr>" +
			"<tr><td><p>Ann</p><p>CEO</p></td><td></td><td>$</td><td>10</td><td></td></tr>" +
			"<tr><td>Bo</td><td></td><td>5</td><td></td></tr><tr><td></td></tr></table>";
		expect(tableLines(table)).toEqual(["Name | Salary | Bonus", "Ann CEO |  | 10", "Bo | 5 | "]);
	});

	it("decodes named and numbered entities, and keeps unknown ones", () => {
		expect(decodeEntities("&lt;a&gt; &#36;5 &#x41; &bogus; &Amp;")).toBe("<a> $5 A &bogus; &");
	});
});
