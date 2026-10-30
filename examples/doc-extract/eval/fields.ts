import type { FieldSpec } from "../src/index.ts";

/** The places of the named executives that the eval asks for, in the Summary Compensation Table's order. */
const PLACES = ["first", "second", "third", "fourth", "fifth"] as const;

const MONEY = { unit: "USD", integer: true } as const;

/** The columns of the Summary Compensation Table that the eval asks for, for the latest fiscal year. */
const COLUMNS: readonly (readonly [string, string])[] = [
	["salary", "Salary"],
	["bonus", "Bonus"],
	["stock_awards", "Stock Awards"],
	["option_awards", "Option Awards"],
	["non_equity_incentive", "Non-Equity Incentive Plan Compensation"],
	["total", "Total"],
];

function executive(place: (typeof PLACES)[number], index: number): [string, FieldSpec][] {
	const who = `the ${place} named executive officer listed in the Summary Compensation Table`;
	const row = `${who}, in the row for the latest fiscal year, in whole US dollars; 0 when the table shows a dash`;
	const prefix = `neo${String(index + 1)}`;
	return [
		[`${prefix}_name`, { kind: "text", instructions: `The full name of ${who}` }],
		[`${prefix}_title`, { kind: "text", instructions: `The principal position of ${who}, as the table gives it` }],
		...COLUMNS.map(([name, column]): [string, FieldSpec] => [
			`${prefix}_${name}`,
			{ kind: "number", instructions: `The ${column} column of ${row}`, field: MONEY },
		]),
	];
}

/** The fields of a DEF 14A case: each named executive's pay for the latest fiscal year, and the CEO pay ratio. */
export const DEF14A_FIELDS: Readonly<Record<string, FieldSpec>> = Object.fromEntries([
	...PLACES.flatMap((place, index) => executive(place, index)),
	[
		"ceo_pay_ratio",
		{
			kind: "number",
			instructions:
				"The CEO pay ratio: how many times the median employee's annual total compensation the CEO's is, such as 271 for a ratio of 271 to 1",
		},
	],
]);

/** The other columns of the table's row, which the sum checks need; they are not scored. */
const EXTRA: readonly (readonly [string, string])[] = [
	["pension_change", "Change in Pension Value and Nonqualified Deferred Compensation Earnings"],
	["all_other", "All Other Compensation"],
];

/** The DEF 14A fields with the columns that the sum checks need. */
export const DEF14A_CHECKED_FIELDS: Readonly<Record<string, FieldSpec>> = {
	...DEF14A_FIELDS,
	...Object.fromEntries(
		PLACES.flatMap((place, index) =>
			EXTRA.map(([name, column]): [string, FieldSpec] => [
				`neo${String(index + 1)}_${name}`,
				{
					kind: "number",
					instructions: `The ${column} column of the ${place} named executive officer listed in the Summary Compensation Table, in the row for the latest fiscal year, in whole US dollars; 0 when the table shows a dash`,
					field: MONEY,
				},
			]),
		),
	),
};

/** One sum check for each executive: the columns of the row add up to its Total. */
export const DEF14A_CHECKS = PLACES.map((_, index) => {
	const neo = `neo${String(index + 1)}`;
	const columns = [
		"salary",
		"bonus",
		"stock_awards",
		"option_awards",
		"non_equity_incentive",
		"pension_change",
		"all_other",
	];
	return { sum: columns.map((column) => `${neo}_${column}`), equals: `${neo}_total`, blankIsZero: true };
});
