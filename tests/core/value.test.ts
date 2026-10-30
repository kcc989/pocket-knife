import { describe, expect, it } from "vitest";
import {
	type JsonObject,
	parseTrace,
	recordedModel,
	replayOf,
	run,
	type StateMachine,
	type TraceEntry,
	type ValueAnswer,
	type ValueQuestion,
} from "../../src/core/index.ts";
import { answered, answering, FACTS, fakeDecider } from "../helpers/fakes.ts";

interface Read extends JsonObject {
	readonly total: number | null;
	readonly done: boolean;
}

const TOTAL: ValueQuestion = { type: "value", kind: "number", instructions: "The total", field: { decimals: 2 } };

/** One step that asks for a total from a short text, then ends. */
const reading = (question: ValueQuestion = TOTAL): StateMachine<Read> => ({
	initial: () => Promise.resolve({ total: null, done: false }),
	questions: (state) => (state.done ? {} : { total: question }),
	transition: (_, answers) => {
		const answer = answers["total"];
		const total = answer?.type === "value" && typeof answer.value === "number" ? answer.value : null;
		return Promise.resolve({ total, done: true });
	},
	view: () => Promise.resolve({ decisionState: { part: "totals" }, extractText: "Total: 12.50" }),
});

const valueOf = (answer: Partial<ValueAnswer>) =>
	answered({ total: { type: "value", kind: "number", value: 12.5, confidence: 0.99, span: [7, 12], ...answer } });

describe("a value question", () => {
	it("sends the view's text to extract from, and keeps the value answer in the trace", async () => {
		const decider = fakeDecider(() => valueOf({}));
		const result = await run(FACTS, reading(), decider);
		expect(result).toMatchObject({ ended: "done", steps: 1, state: { total: 12.5, done: true } });
		expect(decider.requests[0]).toEqual({
			decisionState: { part: "totals" },
			extractText: "Total: 12.50",
			decisionQuestions: { total: TOTAL },
		});
		const text = result.trace.entries.map((entry) => JSON.stringify(entry)).join("\n");
		const answers = parseTrace(text).find((entry) => entry.type === "answers");
		expect(answers?.answers["total"]).toEqual({
			type: "value",
			kind: "number",
			value: 12.5,
			confidence: 0.99,
			span: [7, 12],
		});
	});

	it("fails the run when the answer is of another kind than the question asks", async () => {
		const result = await run(
			FACTS,
			reading(),
			fakeDecider(() => valueOf({ kind: "text", value: "12.50" })),
		);
		expect(result).toMatchObject({
			ended: "failed",
			error: "the answer to total is a text value, not a number one",
		});
	});

	it("is answered with null by the fake decider's default policy", async () => {
		const result = await run(FACTS, reading(), fakeDecider(answering(0.5)));
		expect(result.state).toEqual({ total: null, done: true });
	});

	it("is repeated by a replay, which refuses a recorded value of another kind than the question asks now", async () => {
		const entries: TraceEntry[] = (
			await run(
				FACTS,
				reading(),
				fakeDecider(() => valueOf({})),
			)
		).trace.entries;
		const again = await run(FACTS, reading(), recordedModel(entries), { replay: replayOf(entries) });
		expect(again).toMatchObject({ ended: "done", state: { total: 12.5, done: true } });
		const dated = reading({ ...TOTAL, kind: "date" });
		await expect(run(FACTS, dated, recordedModel(entries), { replay: replayOf(entries) })).rejects.toThrow(
			"the trace does not fit: the answer to total is a number value, not a date one",
		);
	});
});
