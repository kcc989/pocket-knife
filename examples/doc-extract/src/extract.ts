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
import { type Check, checked } from "./checks.ts";
import { type Part, preview, splitParts } from "./parts.ts";
import { selected, selectQuestions } from "./select.ts";

/** The value of one field as the extractor last gave it, and the part it came from. */
export interface FieldValue extends JsonObject {
	readonly value: Json;
	readonly confidence: number | null;
	readonly pNull: number | null;
	/** The index of the part that gave it. */
	readonly part: number;
	readonly found: boolean;
	/** The value is in a sum check that held, which made it found. */
	readonly checked?: boolean;
}

/** Where a case is. */
export interface ExtractState extends JsonObject {
	/** The case's fields, by name, and how many parts its document has. */
	readonly fields: readonly string[];
	readonly parts: number;
	/** The parts read so far, by index, in the order read. */
	readonly read: readonly number[];
	/** The parts just opened, whose missing values the extractor reads next; null while the model picks. */
	readonly open: readonly number[] | null;
	/** How many values the last read found that were missing before it; null before the first read. */
	readonly lastFound: number | null;
	/** The best value of each field so far, by field name. */
	readonly values: Readonly<Record<string, FieldValue>>;
	/** Whether the model stopped reading. */
	readonly stopped: boolean;
	/** Whether the final read is done, for a case with one. */
	readonly finished: boolean;
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
	version: "0.2.0",
	limits: LIMITS,
	definition: definitionOf("doc-extract", { ...TEXTS, found: { ...FOUND }, limits: limitsJson(LIMITS) }),
};

/** The state before the first step; with the whole strategy, every part is open for one read. */
export function initialOf(doc: Document): ExtractState {
	const all = doc.strategy === "whole" ? doc.parts.map((_, index) => index) : [];
	return {
		fields: Object.keys(doc.fields),
		parts: doc.parts.length,
		read: all,
		open: all.length > 0 ? all : null,
		lastFound: null,
		values: {},
		stopped: doc.strategy === "whole",
		finished: false,
		last: "Nothing read yet.",
	};
}

/** Whether a value answer is sure enough to keep without review. */
export function isFound(answer: Pick<ValueAnswer, "value" | "confidence" | "pNull">): boolean {
	const { value, confidence, pNull } = answer;
	if (value === null || (Array.isArray(value) && value.length === 0)) return false;
	return (pNull ?? 0) <= FOUND.pNull && (confidence ?? 0) >= FOUND.confidence;
}

/** The fields not found yet, in the case's order. */
export const missing = (fields: Readonly<Record<string, FieldSpec>>, state: ExtractState): string[] =>
	Object.keys(fields).filter((name) => state.values[name]?.found !== true);

/** A case's fixed data: its fields, its parts, and the least text of a read. */
export interface Document {
	readonly fields: Readonly<Record<string, FieldSpec>>;
	readonly parts: readonly Part[];
	/** A read takes the picked part and the unread parts after it, until it holds this many characters. */
	readonly readChars: number;
	/**
	 * After the model stops, the extractor reads every part read so far at once, in the document's order, and its
	 * answers are the case's values. The reads before it only lead the model to the values still missing.
	 */
	readonly finalRead: boolean;
	/**
	 * How the model finds the values: "navigate" picks one part at a time; "select" asks of every part at once whether
	 * it holds a missing value, and the extractor then reads the likeliest parts, up to `selectChars` characters.
	 */
	readonly strategy: "navigate" | "select" | "whole";
	readonly selectChars: number;
	/** Sum checks: values that add up are found, however sure the extractor was of each. */
	readonly checks: readonly Check[];
}

const unread = (doc: Document, state: ExtractState): number[] =>
	doc.parts.flatMap((_, index) => (state.read.includes(index) ? [] : [index]));

/** Whether the model may still pick: it has not stopped, and a value is missing and a part unread. */
const picks = (doc: Document, state: ExtractState): boolean =>
	!state.stopped && state.open === null && missing(doc.fields, state).length > 0 && unread(doc, state).length > 0;

/** The parts that a read of `index` takes: that part, then the unread parts after it until the read is long enough. */
export function windowOf(doc: Document, state: ExtractState, index: number): number[] {
	const window = [index];
	let size = doc.parts[index]?.text.length ?? 0;
	for (const next of unread(doc, state).filter((other) => other > index)) {
		if (size >= doc.readChars) break;
		window.push(next);
		size += doc.parts[next]?.text.length ?? 0;
	}
	return window;
}

const headingOf = (doc: Document, index: number): string => doc.parts[index]?.heading ?? "";

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
		transition: (state, index) => {
			const open = windowOf(doc, state, index);
			const more = open.length > 1 ? ` and ${String(open.length - 1)} parts after it` : "";
			return {
				...state,
				read: [...state.read, ...open],
				open,
				last: `Opened part ${String(index + 1)}, "${headingOf(doc, index)}"${more}.`,
			};
		},
	});

const stop = (doc: Document) =>
	choiceType<ExtractState, null>({
		type: "stop",
		// Stopping is offered only after a read that found nothing new: while reads pay, the model reads on.
		choices: (state) =>
			picks(doc, state) && state.lastFound === 0 ? [{ key: "stop", text: TEXTS.stop, arg: null, priority: -1 }] : [],
		transition: (state) => ({ ...state, stopped: true, last: "Stopped reading." }),
	});

/** Whether the final read is next: the case has one, the model can pick no more, and it read something. */
export const finalDue = (doc: Document, state: ExtractState): boolean =>
	doc.finalRead && !state.finished && state.open === null && state.read.length > 0 && !picks(doc, state);

/** One value question for each of `names`. */
function valueQuestions(doc: Document, names: readonly string[]): Questions {
	return Object.fromEntries(
		names.map((name) => {
			const spec = doc.fields[name];
			return [
				name,
				{ type: "value", kind: spec?.kind ?? "text", instructions: spec?.instructions ?? name, field: spec?.field },
			];
		}),
	);
}

const NOTHING: FieldValue = { value: null, confidence: null, pNull: null, part: -1, found: false };

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

/** The state after the extractor read the open parts. */
function readValues(doc: Document, state: ExtractState, answers: Answers, parts: readonly number[]): ExtractState {
	const part = parts[0] ?? -1;
	const values = { ...state.values };
	for (const [name, answer] of Object.entries(answers)) {
		if (answer.type !== "value") continue;
		const next = better(values[name], answer, part);
		if (next !== null) values[name] = next;
	}
	const found = Object.values(answers).filter((answer) => answer.type === "value" && isFound(answer)).length;
	const last = `Read ${String(parts.length)} parts from part ${String(part + 1)}: found ${String(found)} values.`;
	return { ...state, open: null, lastFound: found, values: checked(values, doc.checks), last };
}

/** The state after the final read: its answers are the values, found or doubtful. */
function finalValues(doc: Document, state: ExtractState, answers: Answers): ExtractState {
	const values = Object.fromEntries(
		Object.entries(answers).flatMap(([name, answer]) =>
			answer.type === "value" ? [[name, better(undefined, answer, -1) ?? NOTHING] as const] : [],
		),
	);
	return {
		...state,
		values: checked(values, doc.checks),
		finished: true,
		last: "Read every part read so far at once.",
	};
}

/** Whether the select strategy's one question for every part is next. */
const selectDue = (doc: Document, state: ExtractState): boolean =>
	doc.strategy === "select" && state.read.length === 0 && !state.stopped;

/**
 * The questions of a state: the missing values after a pick, a selection of parts, a pick, or every value in the
 * final read.
 */
function questionsOf(
	doc: Document,
	pick: Pick<StateMachine<ExtractState>, "questions">,
	state: ExtractState,
): Questions {
	if (state.open !== null) return valueQuestions(doc, missing(doc.fields, state));
	if (selectDue(doc, state)) return selectQuestions(doc);
	if (finalDue(doc, state)) return valueQuestions(doc, Object.keys(doc.fields));
	return pick.questions(state);
}

/**
 * A case's state machine: the model picks a part or stops; after each pick, the extractor reads that part. A case with
 * a final read ends with one read of every part read.
 */
export function extractMachine(loaded: LoadedCase): StateMachine<ExtractState> {
	const doc: Document = {
		fields: loaded.fields,
		parts: splitParts(loaded.text),
		readChars: loaded.readChars,
		finalRead: loaded.finalRead,
		strategy: loaded.strategy,
		selectChars: loaded.selectChars,
		checks: loaded.checks,
	};
	const pick = picking({
		instructions: TEXTS.instructions,
		limit: TEXTS.choices,
		...joinTypes(readPart(doc), stop(doc)),
	});
	return {
		initial: () => Promise.resolve(initialOf(doc)),
		questions: (state) => questionsOf(doc, pick, state),
		transition: (state, answers) => {
			if (state.open !== null) return Promise.resolve(readValues(doc, state, answers, state.open));
			if (finalDue(doc, state)) return Promise.resolve(finalValues(doc, state, answers));
			if (selectDue(doc, state)) return Promise.resolve(selected(doc, state, answers));
			return pick.transition(state, answers);
		},
		view: (state, tokens, charsPerToken) => Promise.resolve(extractView(doc, state, tokens * charsPerToken)),
	};
}

/** What the models read: for a pick, the values still missing and those found; for a read, the open parts' text. */
export function extractView(doc: Document, state: ExtractState, chars: number): View {
	const reading = state.open ?? (finalDue(doc, state) ? [...state.read].sort((a, b) => a - b) : null);
	if (reading !== null) {
		const text = reading.map((index) => doc.parts[index]?.text ?? "").join("\n\n");
		const heading = headingOf(doc, reading[0] ?? -1);
		// The whole strategy sends the whole text, and the extractor reads as much of it as its window holds.
		const room = doc.strategy === "whole" ? text.length : Math.max(0, chars - 200);
		return { decisionState: { part: heading }, extractText: text.slice(0, room) };
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

/** A field's value and whether it was found or is doubtful, for review. */
function reported(kept: FieldValue = NOTHING): JsonObject {
	const { value, confidence, pNull, found } = kept;
	return { value, status: found ? "found" : "doubtful", confidence, pNull, checked: kept.checked === true };
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
