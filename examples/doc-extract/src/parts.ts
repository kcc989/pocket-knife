/** One part of a document: its heading, and its text with the heading. */
export interface Part {
	readonly heading: string;
	readonly text: string;
}

const HEADING = /^## +(.*)$/;
/** The heading of the text before the first "## " heading. */
export const START = "(start)";

/** A document split at each line that starts with "## "; text before the first heading is a part of its own. */
export function splitParts(text: string): Part[] {
	const parts: { heading: string; lines: string[] }[] = [];
	for (const line of text.split("\n")) {
		const heading = HEADING.exec(line)?.[1]?.trim();
		if (heading !== undefined) parts.push({ heading, lines: [line] });
		else if (parts.length === 0) parts.push({ heading: START, lines: [line] });
		else parts.at(-1)?.lines.push(line);
	}
	return parts
		.map(({ heading, lines }) => ({ heading, text: lines.join("\n").trim() }))
		.filter((part) => part.text !== "" && part.text !== `## ${part.heading}`);
}

/** The first words of a part's body, for the model to judge what the part holds. */
export function preview(part: Part, chars: number): string {
	const body = part.text
		.replace(/^## +.*/, "")
		.replace(/\s+/g, " ")
		.trim();
	return body.length <= chars ? body : `${body.slice(0, chars).trimEnd()}…`;
}
