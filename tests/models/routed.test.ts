import { describe, expect, it } from "vitest";
import type { DecisionRequest } from "../../src/core/index.ts";
import { routedDecider } from "../../src/models/index.ts";
import { answered, answering, failing, fakeDecider } from "../helpers/fakes.ts";

const request: DecisionRequest = {
	decisionState: { part: "Totals" },
	extractText: "Total: 12",
	decisionQuestions: {
		next: { type: "choice", instructions: "Next?", criteria: { o1: "Read", o2: "Stop" } },
		total: { type: "value", kind: "number", instructions: "The total" },
	},
};
const total = { type: "value", kind: "number", value: 12, confidence: 0.99 } as const;
const TOTAL = { type: "value", kind: "number", instructions: "The total" } as const;

describe("routedDecider", () => {
	it("sends the value questions to the extractor and the others to the decision model, and joins their results", async () => {
		const decide = fakeDecider(
			answering(0.5, () => "o2"),
			64_000,
		);
		const extract = fakeDecider(() => answered({ total }), 65_536);
		const routed = routedDecider({ decide, extract });
		expect(routed).toMatchObject({ model: "fake/decider+fake/decider", window: 64_000, charsPerToken: 3 });
		const result = await routed.decide(request);
		expect(decide.requests).toEqual([
			{ decisionState: { part: "Totals" }, decisionQuestions: { next: request.decisionQuestions["next"] } },
		]);
		expect(extract.requests).toEqual([
			{ ...request, decisionQuestions: { total: request.decisionQuestions["total"] } },
		]);
		expect(result.decisionAnswers).toEqual({
			next: { type: "choice", choice: "o2", probabilities: { o2: 0.9 }, confidence: 0.8 },
			total,
		});
		expect(result).toMatchObject({ stopReason: "stop", api: "fake+fake", provider: "fake+fake", tooLong: false });
		expect(result.decisionUsage).toMatchObject({ input: 20, cost: { total: 0.002 } });
	});

	it("calls only the model whose questions the request has", async () => {
		const decide = fakeDecider(answering(0.5));
		const extract = fakeDecider(() => answered({ total }));
		const routed = routedDecider({ decide, extract });
		await routed.decide({ ...request, decisionQuestions: { total: TOTAL } });
		expect([decide.requests.length, extract.requests.length]).toEqual([0, 1]);
		await routed.decide({ decisionState: {}, decisionQuestions: {} });
		expect([decide.requests.length, extract.requests.length]).toEqual([1, 1]);
	});

	it("fails the request when either model fails, with that failure and no answers", async () => {
		const routed = routedDecider({
			decide: fakeDecider(answering(0.5)),
			extract: fakeDecider(() => failing("text too long", true)),
		});
		const result = await routed.decide(request);
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "text too long",
			tooLong: true,
			decisionAnswers: {},
		});
	});
});
