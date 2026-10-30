import { z } from "zod";
import type { FieldValue } from "./extract.ts";

/**
 * A sum check: the fields under `sum` add up to the field `equals`, to the whole unit. With `blankIsZero`, an addend
 * without a value counts as zero, as an empty column of a table does.
 */
export const checkSchema = z
	.object({ sum: z.array(z.string()).min(2), equals: z.string(), blankIsZero: z.boolean().default(false) })
	.strict();
export type Check = z.infer<typeof checkSchema>;

const numberOf = (kept: FieldValue | undefined): number | null => (typeof kept?.value === "number" ? kept.value : null);

/** Whether the values of a check add up, to the whole unit; at least two addends must have a value. */
export function holds(check: Check, values: Readonly<Record<string, FieldValue>>): boolean {
	const parts = check.sum.map((name) => numberOf(values[name]));
	const total = numberOf(values[check.equals]);
	const known = parts.filter((part) => part !== null);
	if (total === null || known.length < 2 || (!check.blankIsZero && known.length < parts.length)) return false;
	return Math.round(known.reduce((a, b) => a + b, 0)) === Math.round(total);
}

const NONE: FieldValue = { value: null, confidence: null, pNull: null, part: -1, found: false };

/**
 * The values with every check that holds marking its fields found: values that add up are taken as right, however sure
 * the extractor was of each. An addend that counted as zero gets the value 0. A check that does not hold, or whose total
 * another check shares, changes nothing.
 */
export function checked(
	values: Readonly<Record<string, FieldValue>>,
	checks: readonly Check[],
): Record<string, FieldValue> {
	const result = { ...values };
	// A total that two checks share was most likely read from the same row twice, so its check is not taken as right.
	const totals = checks.map((check) => numberOf(values[check.equals]));
	const shared = (total: number | null) => total !== null && totals.indexOf(total) !== totals.lastIndexOf(total);
	for (const check of checks.filter((each) => holds(each, values) && !shared(numberOf(values[each.equals])))) {
		for (const name of [...check.sum, check.equals]) {
			const kept = result[name] ?? NONE;
			result[name] = { ...kept, value: numberOf(kept) ?? 0, found: true, checked: true };
		}
	}
	return result;
}
