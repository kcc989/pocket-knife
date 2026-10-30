import {
	type Answers,
	choiceType,
	definitionOf,
	type DomainShared,
	type Json,
	type JsonObject,
	joinTypes,
	type Limits,
	limitsJson,
	picking,
	type Questions,
	type RunResult,
	type StateMachine,
	type ValueAnswer,
	type View,
} from "@osolmaz/switch";
import type { FieldSpec, LoadedCase } from "./case.ts";
import { type Part, preview, splitParts } from "./parts.ts";

/** The value of one field as the extractor last gave it, and the part it came from. */
export interface FieldValue extends JsonObject {
	readonly value: Json;
	readonly confidence: number | null;
	readonly pNull: number | null;
	/** The index of the part that gave it. */
	readonly part: number;
	readonly found: boolean;
}

/** Where a case is. */
export interface ExtractState extends JsonObject {
	/** The case's fields, by name, and how many parts its document has. */
	readonly fields: readonly string[];
	readonly parts: number;
	/** The parts read so far, by index, in the order read. */
	readonly read: readonly number[];
	/** The part just opened, whose missing values the extractor reads next; null while the model picks. */
	readonly open: number | null;
	/** The best value of each field so far, by field name. */
	readonly values: Readonly<Record<string, FieldValue>>;
	/** Whether the model stopped reading. */
	readonly stopped: boolean;
	readonly last: string;
}

/** A value counts as found at or above this confidence, and at or below this probability of null. */
export const FOUND = { confidence: 0.9, pNull: 0.5 } as const;

/** Every part takes two steps, a pick and a read, so the limit is only a safety net. */
export const LIMITS: Limits = { steps: 120, windowShare: 0.9 };

export const TEXTS = {
	instructions:
		"Pick the part whose heading or first words mention one of the missing values. Stop only when no unread part mentions any of them.",
	stop: "Stop reading: no unread part is likely to hold a missing value",
	choices: 255,
	preview: 160,
} as const;

export const DOC_EXTRACT: DomainShared = {
	name: "doc-extract",
	version: "0.1.0",
	limits: LIMITS,
	definition: definitionOf("doc-extract", { ...TEXTS, found: { ...FOUND }, limits: limitsJson(LIMITS) }),
};

/** The state before the first step. */
export const initialOf = (doc: Document): ExtractState => ({
	fields: Object.keys(doc.fields),
	parts: doc.parts.length,
	read: [],
	open: null,
	values: {},
	stopped: false,
	last: "Nothing read yet.",
});

/** Whether a value answer is sure enough to keep without review. */
export function isFound(answer: Pick<ValueAnswer, "value" | "confidence" | "pNull">): boolean {
	const { value, confidence, pNull } = answer;
	if (value === null || (Array.isArray(value) && value.length === 0)) return false;
	return (pNull ?? 0) <= FOUND.pNull && (confidence ?? 0) >= FOUND.confidence;
}

/** The fields not found yet, in the case's order. */
export const missing = (fields: Readonly<Record<string, FieldSpec>>, state: ExtractState): string[] =>
	Object.keys(fields).filter((name) => state.values[name]?.found !== true);

/** A case's fixed data: its fields and its parts. */
export interface Document {
	readonly fields: Readonly<Record<string, FieldSpec>>;
	readonly parts: readonly Part[];
}

const unread = (doc: Document, state: ExtractState): number[] =>
	doc.parts.flatMap((_, index) => (state.read.includes(index) ? [] : [index]));

/** Whether the model may still pick: it has not stopped, and a value is missing and a part unread. */
const picks = (doc: Document, state: ExtractState): boolean =>
	!state.stopped && state.open === null && missing(doc.fields, state).length > 0 && unread(doc, state).length > 0;

const readPart = (doc: Document) =>
	choiceType<ExtractState, number>({
		type: "read",
		choices: (state) =>
			picks(doc, state)
				? unread(doc, state).map((index) => {
						const part = doc.parts[index] ?? { heading: "", text: "" };
						const words = preview(part, TEXTS.preview);
						return {
							key: String(index),
							text: `Read part ${String(index + 1)}, "${part.heading}": ${words}`,
							arg: index,
							priority: index,
							data: { heading: part.heading, chars: part.text.length },
						};
					})
				: [],
		transition: (state, index) => ({
			...state,
			read: [...state.read, index],
			open: index,
			last: `Opened part ${String(index + 1)}, "${doc.parts[index]?.heading ?? ""}".`,
		}),
	});

const stop = (doc: Document) =>
	choiceType<ExtractState, null>({
		type: "stop",
		choices: (state) => (picks(doc, state) ? [{ key: "stop", text: TEXTS.stop, arg: null, priority: -1 }] : []),
		transition: (state) => ({ ...state, stopped: true, last: "Stopped reading." }),
	});

/** One value question for each field still missing. */
function valueQuestions(doc: Document, state: ExtractState): Questions {
	return Object.fromEntries(
		missing(doc.fields, state).map((name) => {
			const spec = doc.fields[name];
			return [
				name,
				{ type: "value", kind: spec?.kind ?? "text", instructions: spec?.instructions ?? name, field: spec?.field },
			];
		}),
	);
}

/** A field's value from an answer, when the answer is better than the value kept: found, or not null where it was. */
function better(kept: FieldValue | undefined, answer: ValueAnswer, part: number): FieldValue | null {
	const next = {
		value: answer.value,
		confidence: answer.confidence ?? null,
		pNull: answer.pNull ?? null,
		part,
		found: isFound(answer),
	};
	if (kept === undefined || next.found) return next;
	return kept.value === null && next.value !== null ? next : null;
}

/** The state after the extractor read the open part. */
function readValues(state: ExtractState, answers: Answers, part: number): ExtractState {
	const values = { ...state.values };
	for (const [name, answer] of Object.entries(answers)) {
		if (answer.type !== "value") continue;
		const next = better(values[name], answer, part);
		if (next !== null) values[name] = next;
	}
	const found = Object.values(answers).filter((answer) => answer.type === "value" && isFound(answer)).length;
	return { ...state, open: null, values, last: `Read part ${String(part + 1)}: found ${String(found)} values.` };
}

/** A case's state machine: the model picks a part or stops; after each pick, the extractor reads that part. */
export function extractMachine(loaded: LoadedCase): StateMachine<ExtractState> {
	const doc: Document = { fields: loaded.fields, parts: splitParts(loaded.text) };
	const pick = picking({
		instructions: TEXTS.instructions,
		limit: TEXTS.choices,
		...joinTypes(readPart(doc), stop(doc)),
	});
	return {
		initial: () => Promise.resolve(initialOf(doc)),
		questions: (state) => (state.open === null ? pick.questions(state) : valueQuestions(doc, state)),
		transition: (state, answers) =>
			state.open === null
				? pick.transition(state, answers)
				: Promise.resolve(readValues(state, answers, state.open)),
		view: (state, tokens, charsPerToken) => Promise.resolve(extractView(doc, state, tokens * charsPerToken)),
	};
}

/** What the models read: for a pick, the values still missing and those found; for a read, the open part's text. */
export function extractView(doc: Document, state: ExtractState, chars: number): View {
	if (state.open !== null) {
		const part = doc.parts[state.open] ?? { heading: "", text: "" };
		return { decisionState: { part: part.heading }, extractText: part.text.slice(0, Math.max(0, chars - 200)) };
	}
	const instructionsOf = (name: string) => doc.fields[name]?.instructions ?? name;
	const found = Object.entries(state.values).filter(([, value]) => value.found);
	return {
		decisionState: {
			missing_values: Object.fromEntries(missing(doc.fields, state).map((name) => [name, instructionsOf(name)])),
			found_values: Object.fromEntries(found.map(([name, value]) => [name, value.value])),
			parts_read: state.read.map((index) => doc.parts[index]?.heading ?? ""),
			last_step: state.last,
		},
	};
}

const NOTHING: FieldValue = { value: null, confidence: null, pNull: null, part: -1, found: false };

/** A field's value and whether it was found or is doubtful, for review. */
function reported(kept: FieldValue = NOTHING): JsonObject {
	const { value, confidence, pNull, found } = kept;
	return { value, status: found ? "found" : "doubtful", confidence, pNull };
}

/**
 * How a case ended: each field's value, "found" when sure enough to keep and else "doubtful" for review, and the parts
 * read of all parts.
 */
export function outcomeOf({ state }: Pick<RunResult<ExtractState>, "state">): JsonObject {
	const values = Object.fromEntries(state.fields.map((name) => [name, reported(state.values[name])]));
	const found = state.fields.filter((name) => state.values[name]?.found === true).length;
	return {
		values,
		found,
		doubtful: state.fields.length - found,
		partsRead: state.read.length,
		parts: state.parts,
		stopped: state.stopped,
	};
}
