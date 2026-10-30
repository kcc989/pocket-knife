import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Json, PICK_ID, run } from "@osolmaz/switch";
import { answered, answering, fakeDecider, type Policy } from "@osolmaz/switch/testing";
import {
	calibration,
	type Check,
	checked,
	DOC_EXTRACT,
	extractMachine,
	extractView,
	holds,
	initialOf,
	isFound,
	loadCase,
	matches,
	numberOf,
	outcomeOf,
	preview,
	scoreOutcome,
	selectedParts,
	selectQuestions,
	splitParts,
	summary,
	windowOf,
} from "../src/index.ts";

/** A case's settings as `case.json` gives them by default. */
const OPTIONS = {
	readChars: 0,
	finalRead: false,
	strategy: "navigate" as const,
	selectChars: 60_000,
	checks: [] as Check[],
};

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
	const loaded = { id: "x", document: "document.md", ...OPTIONS, fields: FIELDS, text: TEXT };

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
				alpha: { value: 1, status: "found", confidence: 0.99, pNull: 0, checked: false },
				beta: { value: "two", status: "doubtful", confidence: 0.5, pNull: 0.1, checked: false },
			},
			found: 1,
			doubtful: 1,
			partsRead: 2,
			parts: 3,
			stopped: true,
		});
	});

	it("shows the pick the values still missing, and cuts an open part's text to the room it has", () => {
		const doc = { fields: FIELDS, parts: splitParts(TEXT), ...OPTIONS };
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
		expect(extractView(doc, { ...state, open: [2] }, 210)).toEqual({
			decisionState: { part: "B" },
			extractText: "## B\nBeta:",
		});
		expect(outcomeOf({ state: initialOf(doc) })).toMatchObject({
			values: { beta: { value: null, status: "doubtful" } },
			doubtful: 2,
		});
	});

	it("reads the picked part with the unread parts after it until the read is long enough", () => {
		const doc = { fields: FIELDS, parts: splitParts(TEXT), ...OPTIONS, readChars: 20 };
		const state = initialOf(doc);
		expect(windowOf(doc, state, 0)).toEqual([0, 1]);
		expect(windowOf(doc, { ...state, read: [1] }, 0)).toEqual([0, 2]);
		expect(windowOf({ ...doc, readChars: 0 }, state, 1)).toEqual([1]);
		expect(extractView(doc, { ...state, open: [1, 2] }, 1000).extractText).toBe(
			"## A\nAlpha: 1.\n\n## B\nBeta: two words here.",
		);
	});

	it("offers to stop only after a read that found nothing new", () => {
		const machine = extractMachine(loaded);
		const doc = { fields: FIELDS, parts: splitParts(TEXT), ...OPTIONS };
		const texts = (lastFound: number | null) => {
			const question = machine.questions({ ...initialOf(doc), lastFound })[PICK_ID];
			return question?.type === "choice" ? Object.values(question.criteria) : [];
		};
		expect(texts(null).some((text) => text.startsWith("Stop"))).toBe(false);
		expect(texts(2).some((text) => text.startsWith("Stop"))).toBe(false);
		expect(texts(0).at(-1)).toMatch(/^Stop reading/);
	});

	it("ends with one read of every part read, whose answers are the values, when the case asks for it", async () => {
		const reads: string[] = [];
		const policy: Policy = (request, call) => {
			if (request.extractText === undefined) {
				return answered({
					[PICK_ID]: { type: "choice", choice: call === 1 ? "o3" : "o1", probabilities: {}, confidence: 1 },
				});
			}
			reads.push(request.extractText);
			const value = (kind: "number" | "text", found: Json) =>
				({
					type: "value",
					kind,
					value: found,
					confidence: [0.5, 0.99, 0.95][reads.length - 1] ?? 0,
					pNull: 0,
				}) as const;
			return answered(
				Object.fromEntries(
					Object.keys(request.decisionQuestions).map((name) => [
						name,
						value(name === "alpha" ? "number" : "text", name === "alpha" ? reads.length : "two"),
					]),
				),
			);
		};
		const result = await run(DOC_EXTRACT, extractMachine({ ...loaded, finalRead: true }), fakeDecider(policy));
		// Part B leaves a value doubtful, the start finds it; then nothing is missing, and the final read takes both parts.
		expect(reads.at(-1)).toBe("Intro line.\n\n## B\nBeta: two words here.");
		expect(result.state).toMatchObject({ finished: true, read: [2, 0] });
		expect(outcomeOf(result)).toMatchObject({
			values: { alpha: { value: 3, status: "found", confidence: 0.95 }, beta: { value: "two", status: "found" } },
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

describe("the select strategy", () => {
	const doc = { fields: FIELDS, parts: splitParts(TEXT), ...OPTIONS, strategy: "select", selectChars: 30 } as const;
	const yes = (p: number) => ({ type: "bool", probability: p }) as const;

	it("asks of every part at once whether it holds a missing value, showing the part's start", () => {
		const questions = selectQuestions(doc);
		expect(Object.keys(questions)).toEqual(["part_1", "part_2", "part_3"]);
		expect(questions["part_2"]?.instructions).toMatch(/Part 2, "A": Alpha: 1\.$/);
	});

	it("reads the likeliest parts that fit the budget, in the document's order, and none below the least probability", () => {
		expect(selectedParts(doc, { part_1: yes(0.1), part_2: yes(0.6), part_3: yes(0.9) })).toEqual([2]);
		expect(
			selectedParts({ ...doc, selectChars: 1000 }, { part_1: yes(0.3), part_2: yes(0.6), part_3: yes(0.9) }),
		).toEqual([0, 1, 2]);
		expect(selectedParts(doc, { part_1: yes(0.1) })).toEqual([]);
	});

	it("runs one selection and one read, and ends without a read when no part is likely", async () => {
		const loadedSelect = {
			id: "x",
			document: "d",
			...OPTIONS,
			strategy: "select" as const,
			fields: FIELDS,
			text: TEXT,
		};
		const policy: Policy = (request) => {
			if (request.extractText !== undefined) {
				expect(request.extractText).toBe("## B\nBeta: two words here.");
				return answered({
					alpha: { type: "value", kind: "number", value: null, pNull: 0.9 },
					beta: { type: "value", kind: "text", value: "two", confidence: 0.97, pNull: 0 },
				});
			}
			return answered({ part_1: yes(0), part_2: yes(0.1), part_3: yes(0.8) });
		};
		const result = await run(DOC_EXTRACT, extractMachine(loadedSelect), fakeDecider(policy));
		expect(result).toMatchObject({ steps: 2, ended: "done", state: { read: [2], stopped: true } });
		expect(outcomeOf(result)).toMatchObject({ found: 1, partsRead: 1 });
		const none = await run(
			DOC_EXTRACT,
			extractMachine(loadedSelect),
			fakeDecider(() => answered({ part_1: yes(0.1), part_2: yes(0.1), part_3: yes(0.1) })),
		);
		expect(none).toMatchObject({ steps: 1, state: { read: [], stopped: true } });
	});
});

describe("sum checks", () => {
	const kept = (value: Json, found = false) => ({ value, confidence: 0.5, pNull: 0, part: 0, found });
	const check = { sum: ["a", "b", "c"], equals: "t", blankIsZero: false };

	it("hold when the addends add up to the total, to the whole unit", () => {
		expect(holds(check, { a: kept(1), b: kept(2), c: kept(3.4), t: kept(6) })).toBe(true);
		expect(holds(check, { a: kept(1), b: kept(2), c: kept(4), t: kept(6) })).toBe(false);
		expect(holds(check, { a: kept(1), b: kept(2), t: kept(3) })).toBe(false);
		expect(holds({ ...check, blankIsZero: true }, { a: kept(1), b: kept(2), t: kept(3) })).toBe(true);
		expect(holds({ ...check, blankIsZero: true }, { a: kept(3), t: kept(3) })).toBe(false);
		expect(holds(check, { a: kept(1), b: kept(2), c: kept(3), t: kept("6") })).toBe(false);
	});

	it("mark the values of a check that holds found, and give a blank addend the value 0", () => {
		const values = { a: kept(1), b: kept(null), c: kept(2), t: kept(3), d: kept(9) };
		expect(checked(values, [{ ...check, blankIsZero: true }])).toEqual({
			a: { ...kept(1, true), checked: true },
			b: { ...kept(0, true), checked: true },
			c: { ...kept(2, true), checked: true },
			t: { ...kept(3, true), checked: true },
			d: kept(9),
		});
		expect(checked(values, [check])).toEqual(values);
		const twice = { a: kept(1), b: kept(2), c: kept(0), t: kept(3), x: kept(1), y: kept(2), z: kept(3) };
		const again = { sum: ["x", "y"], equals: "z", blankIsZero: false };
		expect(checked(twice, [check, again])).toEqual(twice);
		const other = { ...twice, x: kept(5) };
		expect(checked(other, [check, again])).toEqual(other);
	});

	it("run after each read, and the whole strategy reads every part in one step", async () => {
		const fields = { a: FIELDS.alpha, b: FIELDS.alpha, t: FIELDS.alpha };
		const whole = { id: "x", document: "d", ...OPTIONS, strategy: "whole" as const, fields, text: TEXT };
		const sums = [{ sum: ["a", "b"], equals: "t", blankIsZero: false }];
		const number = (value: number) => ({ type: "value", kind: "number", value, confidence: 0.6, pNull: 0 }) as const;
		const decider = fakeDecider(() => answered({ a: number(1), b: number(2), t: number(3) }));
		const result = await run(DOC_EXTRACT, extractMachine({ ...whole, checks: sums }), decider);
		expect(decider.requests[0]?.extractText).toBe(
			splitParts(TEXT)
				.map((part) => part.text)
				.join("\n\n"),
		);
		expect(result).toMatchObject({ steps: 1, state: { read: [0, 1, 2] } });
		expect(outcomeOf(result)).toMatchObject({ found: 3, values: { t: { status: "found", checked: true } } });
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
		expect(matches("VP/ CFO /Treasurer", "VP/CFO/Treasurer")).toBe(true);
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
