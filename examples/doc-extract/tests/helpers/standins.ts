import {
	type Answer,
	type Answers,
	type DecisionRequest,
	type JsonObject,
	PICK_ID,
	type ValueQuestion,
} from "@osolmaz/switch";
import { answered, type Policy } from "@osolmaz/switch/testing";

const STOPWORDS = new Set(["the", "that", "this", "with", "from", "your", "name", "amount"]);

/** The words of a text that carry meaning: lower case, at least three letters, no stop words. */
export const keywords = (text: string): Set<string> =>
	new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word)));

const overlap = (words: ReadonlySet<string>, text: string): number =>
	[...keywords(text)].filter((word) => words.has(word)).length;

/** The words of the values still missing: their names and what they are, from the pick's view. */
function missingWords(state: JsonObject): Set<string> {
	const missing = state["missing_values"];
	const entries =
		typeof missing === "object" && missing !== null && !Array.isArray(missing) ? Object.entries(missing) : [];
	return keywords(entries.map(([name, text]) => `${name.replace(/_/g, " ")} ${JSON.stringify(text)}`).join(" "));
}

/**
 * A stand-in for the decision model: it picks the part whose heading and first words share the most words with the
 * missing values, and stops when no part shares any.
 */
export const keywordPicker: Policy = (request) => {
	const question = request.decisionQuestions[PICK_ID];
	if (question?.type !== "choice") return answered({});
	const words = missingWords(request.decisionState);
	const labels = Object.entries(question.criteria);
	const stop = labels.find(([, text]) => text.startsWith("Stop"))?.[0] ?? "o1";
	const [best, score] = labels.reduce<[string, number]>(
		(top, [label, text]) => (label !== stop && overlap(words, text) > top[1] ? [label, overlap(words, text)] : top),
		[stop, 0],
	);
	const choice = score > 0 ? best : stop;
	return answered({ [PICK_ID]: { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 } });
};

/** A sentence of the text, with where it starts. */
interface Sentence {
	readonly text: string;
	readonly start: number;
}

const sentencesOf = (text: string): Sentence[] =>
	[...text.matchAll(/[^\n]+?(?:\.(?=\s|$)|!|$)/gm)].map((match) => ({ text: match[0].trim(), start: match.index }));

/** Where in a sentence a value of `kind` is, and the value; null when the sentence has none. */
function valueIn(
	sentence: Sentence,
	kind: ValueQuestion["kind"],
): { value: string | number; at: number; end: number } | null {
	const pattern = { date: /\d{4}-\d{2}-\d{2}/, number: /\$?(\d[\d,]*(?:\.\d+)?)/, text: /:\s*(.+?)\.?$/ }[
		kind === "date" || kind === "number" ? kind : "text"
	];
	const match = pattern.exec(sentence.text);
	if (match === null) return null;
	const raw = match[1] ?? match[0];
	const at = sentence.start + match.index + match[0].indexOf(raw);
	const value = kind === "number" ? Number(raw.replace(/,/g, "")) : raw;
	return { value, at, end: at + raw.length };
}

/** The answer of one value question: from the sentence that shares the most words with it and holds such a value. */
function extracted(name: string, question: ValueQuestion, text: string): Answer {
	const words = keywords(`${name.replace(/_/g, " ")} ${question.instructions}`);
	const ranked = sentencesOf(text)
		.map((sentence) => ({
			sentence,
			score: overlap(words, sentence.text.split(":")[0] ?? ""),
			found: valueIn(sentence, question.kind),
		}))
		.filter((entry) => entry.score > 0 && entry.found !== null)
		.sort((a, b) => b.score - a.score);
	const found = ranked[0]?.found;
	if (found == null) return { type: "value", kind: question.kind, value: null, pNull: 0.95, confidence: 0.6 };
	return {
		type: "value",
		kind: question.kind,
		value: found.value,
		pNull: 0.02,
		confidence: 0.97,
		span: [found.at, found.end],
	};
}

/** A stand-in for the extractor: it answers each value question from the sentence of the text that names it. */
export const sentenceExtractor: Policy = (request: DecisionRequest) => {
	const text = request.extractText ?? "";
	const answers: Answers = Object.fromEntries(
		Object.entries(request.decisionQuestions).flatMap(([name, question]) =>
			question.type === "value" ? [[name, extracted(name, question, text)] as const] : [],
		),
	);
	return answered(answers);
};
