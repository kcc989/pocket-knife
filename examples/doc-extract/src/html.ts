/** Marks the start and the end of bold text while the tags are taken out. */
const BOLD_START = "\u0001";
const BOLD_END = "\u0002";

const ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
	bull: "•",
};

/** Text with its HTML entities decoded. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(parseInt(name.slice(2), 16));
		if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}

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

/** The text of a piece of HTML on one line: its tags taken out, its entities decoded and its spaces joined. */
const flat = (html: string): string =>
	decodeEntities(html.replace(/<[^>]+>/g, " "))
		.replace(/[\u200b\ufeff]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** A cell as it reads: a lone currency sign or percent sign says nothing on its own. */
const cellText = (html: string): string => {
	const text = flat(html);
	return /^[$%)]$/.test(text) ? "" : text;
};

/**
 * A table as lines: one for each row with text, its cells joined by " | ". Columns that are empty in every row, which
 * filings use for spacing, are left out, and the empty cells of the other columns stay, so the rows keep their columns.
 */
export function tableLines(html: string): string[] {
	const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
		[...(row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cellText(cell[1] ?? "")),
	);
	const width = Math.max(0, ...rows.map((row) => row.length));
	const used = Array.from({ length: width }, (_, column) => rows.some((row) => (row[column] ?? "") !== ""));
	return rows
		.filter((row) => row.some((cell) => cell !== ""))
		.map((row) => used.flatMap((keep, column) => (keep ? [row[column] ?? ""] : [])).join(" | "));
}

/** Text lines of the HTML: a line for each block, and for each table row with its cells joined by " | ". */
function linesOf(html: string): string[] {
	const text = markBold(html.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, ""))
		.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => `\n${tableLines(table).join("\n")}\n`)
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

/**
 * A filing's HTML as Markdown text: a "## " heading for each short bold line, such as a section's or a table's title,
 * and one line for each paragraph and table row. A heading whose part would hold fewer than `minChars` characters
 * joins the part before it, so that a document has a few hundred parts at most.
 */
export function htmlToMarkdown(html: string, minChars = 1500): string {
	const parts: { heading: string; lines: string[]; size: number }[] = [{ heading: "", lines: [], size: 0 }];
	for (const line of linesOf(html)) {
		const current = parts.at(-1) ?? { heading: "", lines: [], size: 0 };
		if (isHeading(line) && current.size >= minChars) {
			parts.push({ heading: unmark(line).replace(/\s+/g, " ").trim(), lines: [], size: 0 });
			continue;
		}
		const text = unmark(line);
		current.lines.push(text);
		current.size += text.length;
	}
	return parts
		.map(({ heading, lines }) => (heading === "" ? lines.join("\n") : [`## ${heading}`, ...lines].join("\n")))
		.join("\n\n");
}
