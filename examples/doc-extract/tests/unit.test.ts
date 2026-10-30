import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PICK_ID, run } from "@osolmaz/switch";
import { answered, answering, fakeDecider, type Policy } from "@osolmaz/switch/testing";
import {
	calibration,
	DOC_EXTRACT,
	extractMachine,
	extractView,
	initialOf,
	isFound,
	loadCase,
	matches,
	numberOf,
	outcomeOf,
	preview,
	scoreOutcome,
	splitParts,
	summary,
} from "../src/index.ts";

const TEXT = "Intro line.\n## A\nAlpha: 1.\n## Empty\n## B\nBeta: two words here.";
const FIELDS = {
	alpha: { kind: "number", instructions: "Alpha" },
	beta: { kind: "text", instructions: "Beta" },
} as const;

describe("splitParts", () => {
	it("splits at each heading, keeps the text before the first, and drops parts with no body", () => {
		expect(splitParts(TEXT)).toEqual([
			{ heading: "(start)", text: "Intro line." },
			{ heading: "A", text: "## A\nAlpha: 1." },
			{ heading: "B", text: "## B\nBeta: two words here." },
		]);
		expect(preview({ heading: "B", text: "## B\nBeta: two words here." }, 9)).toBe("Beta: two…");
		expect(preview({ heading: "B", text: "## B\nshort" }, 9)).toBe("short");
	});
});

describe("isFound", () => {
	it("keeps a value only when it is not null or empty, likely not null and confident", () => {
		expect(isFound({ value: 1, confidence: 0.95, pNull: 0.1 })).toBe(true);
		expect(isFound({ value: 1, confidence: 0.9, pNull: 0.5 })).toBe(true);
		expect(isFound({ value: null, confidence: 0.99, pNull: 0 })).toBe(false);
		expect(isFound({ value: [], confidence: 0.99, pNull: 0 })).toBe(false);
		expect(isFound({ value: 1, confidence: 0.89, pNull: 0 })).toBe(false);
		expect(isFound({ value: 1, confidence: 0.99, pNull: 0.6 })).toBe(false);
		expect(isFound({ value: 31, confidence: undefined, pNull: undefined })).toBe(false);
	});
});

describe("the doc-extract state machine", () => {
	const loaded = { id: "x", document: "document.md", fields: FIELDS, text: TEXT };

	it("reads the picked part, keeps a doubtful value until a better one comes, and stops when the model stops", async () => {
		let call = 0;
		const policy: Policy = (request) => {
			call += 1;
			if (call === 1)
				return answered({ [PICK_ID]: { type: "choice", choice: "o2", probabilities: {}, confidence: 1 } });
			if (call === 2) {
				expect(request.extractText).toBe("## A\nAlpha: 1.");
				expect(Object.keys(request.decisionQuestions)).toEqual(["alpha", "beta"]);
				return answered({
					alpha: { type: "value", kind: "number", value: 1, confidence: 0.99, pNull: 0 },
					beta: { type: "value", kind: "text", value: null, confidence: 0.4, pNull: 0.9 },
				});
			}
			if (call === 3)
				return answered({ [PICK_ID]: { type: "choice", choice: "o2", probabilities: {}, confidence: 1 } });
			if (call === 4) {
				expect(Object.keys(request.decisionQuestions)).toEqual(["beta"]);
				return answered({ beta: { type: "value", kind: "text", value: "two", confidence: 0.5, pNull: 0.1 } });
			}
			return answered({ [PICK_ID]: { type: "choice", choice: "o2", probabilities: {}, confidence: 1 } });
		};
		const result = await run(DOC_EXTRACT, extractMachine(loaded), fakeDecider(policy));
		expect(result).toMatchObject({ ended: "done", steps: 5 });
		expect(outcomeOf(result)).toEqual({
			values: {
				alpha: { value: 1, status: "found", confidence: 0.99, pNull: 0 },
				beta: { value: "two", status: "doubtful", confidence: 0.5, pNull: 0.1 },
			},
			found: 1,
			doubtful: 1,
			partsRead: 2,
			parts: 3,
			stopped: true,
		});
	});

	it("shows the pick the values still missing, and cuts an open part's text to the room it has", () => {
		const doc = { fields: FIELDS, parts: splitParts(TEXT) };
		const state = {
			...initialOf(doc),
			read: [1],
			values: { alpha: { value: 1, confidence: 1, pNull: 0, part: 1, found: true } },
		};
		expect(extractView(doc, state, 1000).decisionState).toEqual({
			missing_values: { beta: "Beta" },
			found_values: { alpha: 1 },
			parts_read: ["A"],
			last_step: "Nothing read yet.",
		});
		expect(extractView(doc, { ...state, open: 2 }, 210)).toEqual({
			decisionState: { part: "B" },
			extractText: "## B\nBeta:",
		});
		expect(outcomeOf({ state: initialOf(doc) })).toMatchObject({
			values: { beta: { value: null, status: "doubtful" } },
			doubtful: 2,
		});
	});

	it("ends when every part is read, without asking to stop", async () => {
		const result = await run(
			DOC_EXTRACT,
			extractMachine(loaded),
			fakeDecider(answering(0.5, (labels) => labels[0] ?? "")),
		);
		expect(result.state).toMatchObject({ read: [0, 1, 2], stopped: false });
	});

	it("loads a case folder and refuses a case without fields", async () => {
		const folder = await mkdtemp(join(tmpdir(), "doc-extract-case-"));
		await writeFile(join(folder, "case.json"), JSON.stringify({ id: "x", fields: FIELDS }));
		await writeFile(join(folder, "document.md"), TEXT);
		await expect(loadCase(folder)).resolves.toMatchObject({ id: "x", document: "document.md", text: TEXT });
		await writeFile(join(folder, "case.json"), JSON.stringify({ id: "x", fields: {} }));
		await expect(loadCase(folder)).rejects.toThrow(/no fields/);
		await rm(folder, { recursive: true });
	});
});

describe("scoring", () => {
	it("matches numbers to the whole unit, text without case or end punctuation, and anything else exactly", () => {
		expect(numberOf("$1,850.40")).toBe(1850.4);
		expect(numberOf("271:1")).toBe(271);
		expect(numberOf("none")).toBeNull();
		expect(numberOf(true)).toBeNull();
		expect(matches(1850.4, 1850)).toBe(true);
		expect(matches("$1,850", 1850)).toBe(true);
		expect(matches(1851, 1850)).toBe(false);
		expect(matches("x", 1)).toBe(false);
		expect(matches(" Bluefin  Cafe. ", "bluefin cafe")).toBe(true);
		expect(matches("Senior Vice President – CFO & Treasurer", "Senior Vice President - CFO and Treasurer")).toBe(
			true,
		);
		expect(matches(null, null)).toBe(true);
		expect(matches("a", null)).toBe(false);
		expect(matches(["a"], ["a"])).toBe(true);
	});

	it("scores an outcome's fields, totals them, and buckets the rated values by confidence", () => {
		const outcome = {
			values: {
				a: { value: 1, status: "found", confidence: 0.95 },
				b: { value: 2, status: "found", confidence: 0.8 },
				c: { value: null, status: "doubtful", confidence: 0.3 },
				d: { value: "x", status: "doubtful", confidence: 0.2 },
			},
		};
		const scores = scoreOutcome(outcome, { a: 1, b: 3, c: null, d: "y", e: 5 });
		expect(scores.map((score) => [score.field, score.status, score.correct])).toEqual([
			["a", "found", true],
			["b", "found", false],
			["c", "doubtful", true],
			["d", "doubtful", false],
			["e", "doubtful", false],
		]);
		expect(summary(scores)).toEqual({
			fields: 5,
			correct: 2,
			accuracy: 0.4,
			wrongFound: 1,
			wrongFoundShare: 0.2,
			doubtful: 3,
			doubtfulShare: 0.6,
		});
		expect(calibration(scores)).toEqual([
			{ bucket: "0.9+", values: 1, correct: 1, accuracy: 1 },
			{ bucket: "0.7-0.9", values: 1, correct: 0, accuracy: 0 },
			{ bucket: "<0.7", values: 1, correct: 0, accuracy: 0 },
		]);
		expect(summary([])).toMatchObject({ accuracy: 0 });
		expect(scoreOutcome(null, { a: null })[0]).toMatchObject({ status: "doubtful", correct: true });
	});
});
