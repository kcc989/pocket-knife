import {
	addedUsage,
	type Decider,
	type DecisionRequest,
	type DecisionResult,
	noUsage,
	type Questions,
} from "../core/index.ts";

export interface RoutedOptions {
	/** Answers the bool, choice and score questions. */
	readonly decide: Decider;
	/** Answers the value questions, from the request's `extractText`. */
	readonly extract: Decider;
}

/** The questions of a request, split into those that are value questions and those that are not. */
function split(questions: Questions): { readonly values: Questions; readonly others: Questions } {
	const entries = Object.entries(questions);
	return {
		values: Object.fromEntries(entries.filter(([, question]) => question.type === "value")),
		others: Object.fromEntries(entries.filter(([, question]) => question.type !== "value")),
	};
}

/** The decision model's request: without the text to extract from, which only the extractor reads. */
function decideRequest(request: DecisionRequest, questions: Questions): DecisionRequest {
	const { decisionState, decisionImages } = request;
	return { decisionState, ...(decisionImages === undefined ? {} : { decisionImages }), decisionQuestions: questions };
}

/** The results of both models as one: their answers and their usage together. The first failure fails it. */
function merged(first: DecisionResult, rest: readonly DecisionResult[], model: string): DecisionResult {
	const results = [first, ...rest];
	const failed = results.find((result) => result.stopReason !== "stop");
	const usages = results.flatMap((result) => (result.decisionUsage === undefined ? [] : [result.decisionUsage]));
	const answers = results.flatMap((result) => Object.entries(result.decisionAnswers));
	return {
		...(failed ?? first),
		api: results.map((result) => result.api).join("+"),
		provider: results.map((result) => result.provider).join("+"),
		model,
		decisionAnswers: failed === undefined ? Object.fromEntries(answers) : {},
		...(usages.length === 0 ? {} : { decisionUsage: usages.reduce(addedUsage, noUsage()) }),
		tooLong: results.some((result) => result.tooLong),
		milliseconds: Math.max(...results.map((result) => result.milliseconds)),
	};
}

/**
 * A decider that sends the value questions to `extract` and the others to `decide`, both at once, and gives their
 * answers and usage as one result. A request fails when either model fails.
 */
export function routedDecider({ decide, extract }: RoutedOptions): Decider {
	const model = `${decide.model}+${extract.model}`;
	return {
		model,
		window: Math.min(decide.window, extract.window),
		charsPerToken: Math.min(decide.charsPerToken, extract.charsPerToken),
		async decide(request) {
			const { values, others } = split(request.decisionQuestions);
			const asked = Object.keys(values).length > 0;
			const calls = [
				...(Object.keys(others).length > 0 || !asked ? [decide.decide(decideRequest(request, others))] : []),
				...(asked ? [extract.decide({ ...request, decisionQuestions: values })] : []),
			];
			const [first, ...rest] = await Promise.all(calls);
			if (first === undefined) throw new Error("a routed request made no call");
			return merged(first, rest, model);
		},
	};
}
