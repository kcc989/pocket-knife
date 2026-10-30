import type { Json, JsonObject } from "@osolmaz/switch";

/** Text as it compares: lower case, single spaces, without punctuation at its ends. */
const plainText = (text: string): string =>
	text
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/^[\s.,;:"'()]+|[\s.,;:"'()]+$/g, "");

/** A number in a value: a number, or text that reads as one, such as "$1,850" or "271:1". */
export function numberOf(value: Json): number | null {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return null;
	const match = /-?\d[\d,]*(?:\.\d+)?/.exec(value);
	return match === null ? null : Number(match[0].replace(/,/g, ""));
}

/** Whether a value matches the expected one: numbers to the whole unit (money to the dollar), text without case. */
export function matches(actual: Json, expected: Json): boolean {
	if (expected === null || actual === null) return expected === actual;
	if (typeof expected === "number") {
		const number = numberOf(actual);
		return number !== null && Math.round(number) === Math.round(expected);
	}
	if (typeof expected === "string" && typeof actual === "string") return plainText(actual) === plainText(expected);
	return JSON.stringify(actual) === JSON.stringify(expected);
}

/** One field of a case, scored. */
export interface FieldScore {
	readonly field: string;
	readonly expected: Json;
	readonly value: Json;
	readonly status: "found" | "doubtful";
	readonly confidence: number | null;
	readonly correct: boolean;
}

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Each expected field of a case's outcome, scored against the answer key; a field the outcome lacks is doubtful. */
export function scoreOutcome(
	outcome: Readonly<Record<string, unknown>> | null,
	expected: Readonly<Record<string, Json>>,
): FieldScore[] {
	const values = outcome?.["values"];
	return Object.entries(expected).map(([field, want]) => {
		const got = isObject(values) ? values[field] : undefined;
		const reported = isObject(got) ? got : {};
		const value = reported["value"] ?? null;
		const confidence = typeof reported["confidence"] === "number" ? reported["confidence"] : null;
		const status = reported["status"] === "found" ? "found" : "doubtful";
		return { field, expected: want, value, status, confidence, correct: matches(value, want) };
	});
}

/** The totals of scored fields: accuracy, wrong values kept as found, and the share sent to review. */
export function summary(scores: readonly FieldScore[]): JsonObject {
	const share = (count: number) => (scores.length === 0 ? 0 : count / scores.length);
	const correct = scores.filter((score) => score.correct).length;
	const wrongFound = scores.filter((score) => score.status === "found" && !score.correct).length;
	const doubtful = scores.filter((score) => score.status === "doubtful").length;
	return {
		fields: scores.length,
		correct,
		accuracy: share(correct),
		wrongFound,
		wrongFoundShare: share(wrongFound),
		doubtful,
		doubtfulShare: share(doubtful),
	};
}

/** Confidence buckets for calibration: the lowest confidence of each, highest first. */
export const BUCKETS = [
	{ name: "0.9+", min: 0.9 },
	{ name: "0.7-0.9", min: 0.7 },
	{ name: "<0.7", min: Number.NEGATIVE_INFINITY },
] as const;

/** Accuracy by confidence bucket, over the fields that have a value and a confidence. */
export function calibration(scores: readonly FieldScore[]): JsonObject[] {
	const rated = scores.filter((score) => score.confidence !== null && score.value !== null);
	return BUCKETS.map(({ name, min }, index) => {
		const above = index === 0 ? Number.POSITIVE_INFINITY : (BUCKETS[index - 1]?.min ?? 0);
		const inside = rated.filter((score) => (score.confidence ?? 0) >= min && (score.confidence ?? 0) < above);
		const correct = inside.filter((score) => score.correct).length;
		return {
			bucket: name,
			values: inside.length,
			correct,
			accuracy: inside.length === 0 ? null : correct / inside.length,
		};
	});
}
