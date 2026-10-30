import type { Answers, Questions } from "@osolmaz/switch";
import type { Document, ExtractState } from "./extract.ts";
import { preview } from "./parts.ts";

/** The texts of the select strategy's questions. */
export const SELECT_TEXTS = {
	question: "Does this part of the document hold one or more of the values listed under missing_values?",
	yes: "The part holds at least one of the missing values",
	no: "The part holds none of the missing values",
	preview: 300,
	/** Parts the model gives a lower probability than this are not read, whatever room is left. */
	least: 0.2,
} as const;

const idOf = (index: number): string => `part_${String(index + 1)}`;

/** One yes-or-no question for each part: does it hold a missing value? Each question shows its part's start. */
export function selectQuestions(doc: Document): Questions {
	return Object.fromEntries(
		doc.parts.map((part, index) => [
			idOf(index),
			{
				type: "bool",
				instructions: `${SELECT_TEXTS.question} Part ${String(index + 1)}, "${part.heading}": ${preview(part, SELECT_TEXTS.preview)}`,
				criteria: { true: SELECT_TEXTS.yes, false: SELECT_TEXTS.no },
			},
		]),
	);
}

/**
 * The parts to read, in the document's order: the likeliest first, while they fit in the budget of `selectChars`
 * characters and the model gives them at least the least probability.
 */
export function selectedParts(doc: Document, answers: Answers): number[] {
	const ranked = doc.parts
		.map((part, index) => {
			const answer = answers[idOf(index)];
			return { index, size: part.text.length, p: answer?.type === "bool" ? answer.probability : 0 };
		})
		.filter((part) => part.p >= SELECT_TEXTS.least)
		.sort((a, b) => b.p - a.p || a.index - b.index);
	const chosen: number[] = [];
	let size = 0;
	for (const part of ranked) {
		if (size + part.size > doc.selectChars && chosen.length > 0) continue;
		chosen.push(part.index);
		size += part.size;
	}
	return chosen.sort((a, b) => a - b);
}

/** The state after the selection: the chosen parts are open for one read, and the model picks no more. */
export function selected(doc: Document, state: ExtractState, answers: Answers): ExtractState {
	const open = selectedParts(doc, answers);
	if (open.length === 0) return { ...state, stopped: true, last: "Selected no part to read." };
	return {
		...state,
		read: open,
		open,
		stopped: true,
		last: `Selected ${String(open.length)} parts to read.`,
	};
}
