import { decodeEntities } from "./entities.ts";
import { TABLE_MARK, tableLines } from "./table.ts";

/** Marks the start and the end of bold text while the tags are taken out. */
const BOLD_START = "\u0001";
const BOLD_END = "\u0002";

const BOLD_STYLE = /font-weight:\s*(bold|[6-9]00)/i;

/** The HTML with bold elements' text between the bold marks: `<b>`, `<strong>` and elements styled bold. */
function markBold(html: string): string {
	return html
		.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, `${BOLD_START}$2${BOLD_END}`)
		.replace(
			/<(span|font|p|div)\b([^>]*)>([^<]*)<\/\1>/gi,
			(whole, tag: string, attributes: string, inner: string) =>
				BOLD_STYLE.test(attributes) && inner.trim() !== ""
					? `<${tag}>${BOLD_START}${inner}${BOLD_END}</${tag}>`
					: whole,
		);
}

/** Text lines of the HTML: a line for each block, and for each table row with its cells joined by " | ". */
function linesOf(html: string): string[] {
	const text = markBold(html.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, ""))
		.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => `\n${TABLE_MARK}\n${tableLines(table).join("\n")}\n`)
		.replace(/<(br|hr)\b[^>]*>/gi, "\n")
		.replace(/<\/?(p|div|li|ul|ol|h[1-6]|section|center)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	return decodeEntities(text)
		.split("\n")
		.map((line) =>
			line
				.replace(/[\u200b\ufeff]/g, "")
				.replace(/[^\S\n]+/g, " ")
				.trim(),
		)
		.filter((line) => line.replace(new RegExp(`[${BOLD_START}${BOLD_END}\\s|]`, "g"), "") !== "");
}

/** Whether a line is a heading: short, all bold, with letters, and no sentence or table row. */
function isHeading(line: string): boolean {
	const plain = line.replace(new RegExp(`[${BOLD_START}${BOLD_END}]`, "g"), "").trim();
	const bold = [...line.matchAll(new RegExp(`${BOLD_START}([^${BOLD_END}]*)${BOLD_END}`, "g"))]
		.map((match) => match[1] ?? "")
		.join("")
		.trim();
	const sentence = /[.:;]$/.test(plain) && !/[A-Z]{2,}\.?$/.test(plain);
	return (
		plain.length >= 3 &&
		plain.length <= 120 &&
		bold === plain.replace(/\s+/g, " ") &&
		/[A-Za-z]{3}/.test(plain) &&
		!plain.includes(" | ") &&
		!sentence
	);
}

const unmark = (line: string): string => line.replace(new RegExp(`[${BOLD_START}${BOLD_END}]`, "g"), "");

/** Whether a line reads as a title: short, mostly capitalized words, and no sentence or table row. */
function isTitle(line: string): boolean {
	const plain = unmark(line).trim();
	const words = plain.split(" ");
	const capitalized = words.filter((word) => /^[A-Z0-9(“"]/.test(word)).length;
	return (
		plain.length >= 3 &&
		plain.length <= 100 &&
		!/[.;:,]$/.test(plain) &&
		!plain.includes(" | ") &&
		capitalized * 5 >= words.length * 3
	);
}

/** The index of a table's title: a title line at most three lines before the table's mark; -1 when there is none. */
function titleBefore(lines: readonly string[], mark: number): number {
	for (let index = mark - 1; index >= Math.max(0, mark - 3); index -= 1) {
		if (isTitle(lines[index] ?? "")) return index;
	}
	return -1;
}

/** The indexes of the lines that start a part: short bold lines, and tables' titles. */
function headingLines(lines: readonly string[]): Set<number> {
	const headings = new Set(lines.flatMap((line, index) => (isHeading(line) ? [index] : [])));
	lines.forEach((line, index) => {
		if (line === TABLE_MARK) headings.add(titleBefore(lines, index));
	});
	headings.delete(-1);
	return headings;
}

/**
 * A filing's HTML as Markdown text: a "## " heading for each short bold line and each table's title, and one line for
 * each paragraph and table row. A heading whose part would hold fewer than `minChars` characters joins the part
 * before it, so that a document has a few hundred parts at most.
 */
export function htmlToMarkdown(html: string, minChars = 1500): string {
	const lines = linesOf(html);
	const headings = headingLines(lines);
	const parts: { heading: string; lines: string[]; size: number }[] = [{ heading: "", lines: [], size: 0 }];
	lines.forEach((line, index) => {
		const current = parts.at(-1) ?? { heading: "", lines: [], size: 0 };
		if (line === TABLE_MARK) return;
		if (headings.has(index) && current.size >= minChars) {
			parts.push({ heading: unmark(line).replace(/\s+/g, " ").trim(), lines: [], size: 0 });
			return;
		}
		const text = unmark(line);
		current.lines.push(text);
		current.size += text.length;
	});
	return parts
		.map(({ heading, lines: body }) => (heading === "" ? body.join("\n") : [`## ${heading}`, ...body].join("\n")))
		.join("\n\n");
}
