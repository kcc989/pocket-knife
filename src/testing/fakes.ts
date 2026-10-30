import type {
	Answer,
	Answers,
	Decider,
	DecisionRequest,
	DecisionResult,
	DecisionUsage,
	Question,
} from "../core/index.ts";

/** What a fake request costs: 10 input tokens at a tenth of a cent. */
export const FAKE_USAGE: DecisionUsage = {
	input: 10,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 10,
	cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
};

/** How a fake decider answers each request: by the request and the request's number, from 1. */
export type Policy = (request: DecisionRequest, call: number) => DecisionResult;

/** A decider that answers with `policy` and keeps every request it received, so that tests make no model calls. */
export function fakeDecider(policy: Policy, window = 64_000): Decider & { readonly requests: DecisionRequest[] } {
	const requests: DecisionRequest[] = [];
	return {
		model: "fake/decider",
		window,
		charsPerToken: 3,
		requests,
		decide(request) {
			requests.push(request);
			return Promise.resolve(policy(request, requests.length));
		},
	};
}

const RESULT = {
	api: "fake",
	provider: "fake",
	model: "decider",
	timestamp: 0,
	tooLong: false,
	milliseconds: 1,
} as const;

/** A fake decider's result with `answers`. */
export const answered = (answers: Answers): DecisionResult => ({
	...RESULT,
	decisionAnswers: answers,
	decisionUsage: FAKE_USAGE,
	stopReason: "stop",
});

/**
 * Answers every bool question with `probability`, every choice question with `pick(labels)` at probability 0.9, the
 * last label by default, every score question with 1, and every value question with null.
 */
export function answering(
	probability: number,
	pick: (labels: string[]) => string = (labels) => labels.at(-1) ?? "",
): Policy {
	const answerOf = (question: Question): Answer => {
		switch (question.type) {
			case "choice": {
				const choice = pick(Object.keys(question.criteria));
				return { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.8 };
			}
			case "bool":
				return { type: "bool", probability };
			case "score":
				return { type: "score", score: 1, confidence: 0.5 };
			case "value":
				return { type: "value", kind: question.kind, value: null, pNull: 1, confidence: 0.5 };
		}
	};
	return (request) =>
		answered(
			Object.fromEntries(
				Object.entries(request.decisionQuestions).map(([id, question]) => [id, answerOf(question)]),
			),
		);
}

/** A failed request, as a decider reports it; `tooLong` when the request did not fit the model's window. */
export const failing = (message = "failed", tooLong = false): DecisionResult => ({
	...RESULT,
	decisionAnswers: {},
	decisionUsage: FAKE_USAGE,
	stopReason: "error",
	errorMessage: message,
	tooLong,
});
