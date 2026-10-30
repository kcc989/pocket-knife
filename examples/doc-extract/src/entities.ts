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
