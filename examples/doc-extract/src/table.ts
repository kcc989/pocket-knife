import { decodeEntities } from "./entities.ts";

/** One cell of a table row as the HTML has it. */
interface Cell {
	readonly text: string;
	readonly colspan: number;
	readonly rowspan: number;
}

/** One place of the table's grid: the text of the cell that covers it, and how. */
interface Slot {
	readonly text: string;
	/** The place is the cell's own: its first row and first column. */
	readonly own: boolean;
	/** The place is in the cell's first row, which a header spans across its columns. */
	readonly top: boolean;
	readonly colspan: number;
}

/** Marks the start of a table among the text lines. */
export const TABLE_MARK = "\u0003";

/** The marks that `htmlToMarkdown` puts around bold text. */
const BOLD = "\u0001\u0002";
const MARKS = new RegExp(`[${BOLD}]`, "g");
const ZERO_WIDTH = new RegExp("[\u200b\ufeff]", "g");
const LONE_SIGN = new RegExp(`^[${BOLD}]*[$%)][${BOLD}]*$`);

/** The text of a piece of HTML on one line: its tags taken out, its entities decoded and its spaces joined. */
export const flat = (html: string): string =>
	decodeEntities(html.replace(/<[^>]+>/g, " "))
		.replace(ZERO_WIDTH, "")
		.replace(/\s+/g, " ")
		.trim();

/** A cell's text: a lone currency sign, percent sign or parenthesis says nothing on its own. */
const cellText = (html: string): string => {
	const text = flat(html);
	return LONE_SIGN.test(text) ? "" : text;
};

const span = (attributes: string, name: string): number => {
	const value = Number(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i").exec(attributes)?.[1] ?? "1");
	return Math.min(Math.max(1, value), 64);
};

function rowsOf(html: string): Cell[][] {
	return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
		[...(row[1] ?? "").matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => ({
			text: cellText(cell[2] ?? ""),
			colspan: span(cell[1] ?? "", "colspan"),
			rowspan: span(cell[1] ?? "", "rowspan"),
		})),
	);
}

/** Puts `cell` in the grid at its row and column, over every place it spans. */
function place(grid: Slot[][], cell: Cell, row: number, column: number): void {
	const rows = Math.min(cell.rowspan, grid.length - row);
	for (let down = 0; down < rows; down += 1) {
		const line = grid[row + down] ?? [];
		for (let across = 0; across < cell.colspan; across += 1) {
			line[column + across] = {
				text: cell.text,
				own: down === 0 && across === 0,
				top: down === 0,
				colspan: cell.colspan,
			};
		}
	}
}

/** The table as a grid of places, where a cell that spans rows or columns covers each place it spans. */
export function gridOf(rows: readonly (readonly Cell[])[]): Slot[][] {
	const grid: Slot[][] = rows.map(() => []);
	rows.forEach((cells, row) => {
		let column = 0;
		for (const cell of cells) {
			while (grid[row]?.[column] !== undefined) column += 1;
			place(grid, cell, row, column);
			column += cell.colspan;
		}
	});
	return grid;
}

/** A cell that holds an amount: a number, maybe in parentheses or with a sign, or a dash for none. */
const AMOUNT = /^\(?[$€£]?\s*-?\d[\d,]*(\.\d+)?\)?%?(\s*\(\d+\))?$|^[—–-]{1,2}$|^-0-$/;

const ownText = (slot: Slot | undefined): string => (slot?.own === true ? slot.text.replace(MARKS, "") : "");

/** Whether a row holds data: two or more amounts. */
const isData = (row: readonly (Slot | undefined)[]): boolean =>
	row.filter((slot) => AMOUNT.test(ownText(slot))).length >= 2;

/**
 * Each column's name: the texts of the header rows above it, top to bottom, without repeats. A header cell that spans
 * more than half of the table, such as its title, names no column.
 */
function columnNames(header: readonly (readonly (Slot | undefined)[])[], width: number): string[] {
	const naming = (slot: Slot | undefined): slot is Slot =>
		slot?.top === true && slot.text !== "" && slot.colspan * 2 <= width;
	return Array.from({ length: width }, (_, column) => {
		const texts = header.flatMap((row) => {
			const slot = row[column];
			return naming(slot) ? [slot.text.replace(MARKS, "")] : [];
		});
		return texts.filter((text, index) => texts.indexOf(text) === index).join(" ");
	});
}

/** A data row as one line: each cell with its column's name, "Salary ($): 575,000". */
function labeled(row: readonly (Slot | undefined)[], names: readonly string[], used: readonly number[]): string {
	return used
		.flatMap((column) => {
			const text = ownText(row[column]);
			const name = names[column] ?? "";
			if (text === "") return [];
			return [name === "" ? text : `${name}: ${text}`];
		})
		.join(" | ");
}

/** A row as one line of its cells, for a table without data rows. */
const plainRow = (row: readonly (Slot | undefined)[], used: readonly number[]): string =>
	used
		.map((column) => {
			const slot = row[column];
			return slot?.own === true ? slot.text : "";
		})
		.join(" | ");

/**
 * A table as lines. A table with data rows, which hold amounts, gives each data row as one line with every cell named
 * by its column's header rows, so a reader needs no column positions. Any other table gives one line for each row,
 * its cells joined by " | ". Columns with no text in any row, which filings use for spacing, are left out.
 */
export function tableLines(html: string): string[] {
	const grid = gridOf(rowsOf(html));
	const width = Math.max(0, ...grid.map((row) => row.length));
	const used = Array.from({ length: width }, (_, column) => column).filter((column) =>
		grid.some((row) => ownText(row[column]) !== ""),
	);
	const first = grid.findIndex(isData);
	if (first <= 0) return grid.map((row) => plainRow(row, used)).filter((line) => line.replace(/[\s|]/g, "") !== "");
	const names = columnNames(grid.slice(0, first), width);
	return grid
		.slice(first)
		.map((row) => labeled(row, names, used))
		.filter((line) => line !== "");
}
