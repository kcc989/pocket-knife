import type { z } from "zod";
import type { decisionUsageSchema } from "./record.ts";
import type { DecisionUsage } from "./types.ts";

/** No tokens at no cost. */
export const noUsage = (): DecisionUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** The sum of a count that only some providers report; none while neither usage has it. */
const optionalSum = (a?: number, b?: number): number | undefined =>
	a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/** The sum of two usages; a request without usage adds nothing. */
export function addedUsage(sum: DecisionUsage, usage: z.infer<typeof decisionUsageSchema> | undefined): DecisionUsage {
	if (usage === undefined) return sum;
	const { cost } = usage;
	const cacheWrite1h = optionalSum(sum.cacheWrite1h, usage.cacheWrite1h);
	const reasoning = optionalSum(sum.reasoning, usage.reasoning);
	return {
		input: sum.input + usage.input,
		output: sum.output + usage.output,
		cacheRead: sum.cacheRead + usage.cacheRead,
		cacheWrite: sum.cacheWrite + usage.cacheWrite,
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: sum.totalTokens + usage.totalTokens,
		cost: {
			input: sum.cost.input + cost.input,
			output: sum.cost.output + cost.output,
			cacheRead: sum.cost.cacheRead + cost.cacheRead,
			cacheWrite: sum.cost.cacheWrite + cost.cacheWrite,
			total: sum.cost.total + cost.total,
		},
	};
}
