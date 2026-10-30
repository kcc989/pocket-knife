import { z } from "zod";
import {
	type Answers,
	type Decider,
	type DecisionRequest,
	type DecisionResult,
	type DecisionUsage,
	type Json,
	type JsonObject,
	VALUE_KINDS,
	type ValueAnswer,
	type ValueQuestion,
} from "../core/index.ts";

/** Clairic's id in Workers AI. */
export const CLAIRIC = "@cf/cloudflare/clairic";
/** Workers AI's price for Clairic: US dollars per input token. */
export const CLAIRIC_PRICE = 0.1 / 1_000_000;
const WINDOW = 65_536;

/** What Clairic takes, as its input schema has it. */
export interface ClairicInput {
	readonly model: "clairic";
	readonly state: string;
	readonly fields: Readonly<Record<string, JsonObject>>;
	readonly images?: readonly string[];
}

/** Runs a Workers AI model: `env.AI.run` in a Worker, or `cloudflareRest` outside one. It gives the model's output. */
export type AiRun = (model: string, inputs: ClairicInput) => Promise<unknown>;

export interface ClairicOptions {
	readonly run: AiRun;
	/** Characters per token for size estimates: Clairic counted 4.2 on English filings, and 2.3 on short dense text. */
	readonly charsPerToken?: number;
	/**
	 * What a truncated read gives: "fail" fails the request as too long, so the loop sends a smaller view; "keep"
	 * keeps the answers that Clairic gave from the start of the text, for a caller that sends a text larger than it.
	 */
	readonly truncated?: "fail" | "keep";
	readonly now?: () => number;
}

const json: z.ZodType<Json> = z.json();
const span = z.tuple([z.number().int(), z.number().int()]);
const point = z.union([z.number(), z.string()]).nullish();
const answerSchema = z.object({
	type: z.enum(VALUE_KINDS),
	value: json,
	guess: json.optional(),
	p_null: z.number().optional(),
	confidence: z.number().optional(),
	span: span.nullish(),
	spans: z.array(span).nullish(),
	median: point,
	p10: point,
	p90: point,
});
const outputSchema = z.object({
	answers: z.record(z.string(), answerSchema),
	truncated: z.boolean(),
	usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});
type Output = z.infer<typeof outputSchema>;

/** A field name as Clairic takes it. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/**
 * Clairic's field name of each question id: the id itself when Clairic takes it, since the name tells Clairic what
 * the value is, or else `q` and the question's place.
 */
export function fieldNames(ids: readonly string[]): Map<string, string> {
	const names = new Map<string, string>();
	ids.forEach((id, index) => {
		let name = FIELD_NAME.test(id) && !names.has(id) ? id : `q${String(index)}`;
		while (names.has(name)) name = `${name}_`;
		names.set(name, id);
	});
	return names;
}

const fieldOf = (question: ValueQuestion): JsonObject => ({
	...question.field,
	type: question.kind,
	instructions: question.instructions,
});

/** The request as Clairic takes it; its state is the text to extract from, or else the decision state as JSON. */
function inputOf(request: DecisionRequest, questions: ReadonlyMap<string, Field>): ClairicInput {
	const fields = Object.fromEntries([...questions].map(([name, { question }]) => [name, fieldOf(question)]));
	const images = request.decisionImages?.map((image) => `data:${image.mimeType};base64,${image.data}`);
	return {
		model: "clairic",
		state: request.extractText ?? JSON.stringify(request.decisionState),
		fields,
		...(images === undefined || images.length === 0 ? {} : { images }),
	};
}

/** Clairic's answer as a value answer, without the fields that it left out or set to null. */
function answerOf(answer: z.infer<typeof answerSchema>): ValueAnswer {
	const { type, value, guess, p_null, confidence, span: at, spans, median, p10, p90 } = answer;
	const optional = { confidence, pNull: p_null, guess, span: at, spans, median, p10, p90 };
	const present = Object.entries(optional).filter(([, field]) => field !== undefined && field !== null);
	return { type: "value", kind: type, value, ...Object.fromEntries(present) };
}

/** Clairic's token counts, at its price. */
export function usageOf(output: Pick<Output, "usage">): DecisionUsage {
	const { input_tokens: input, output_tokens: tokensOut } = output.usage;
	const cost = input * CLAIRIC_PRICE;
	return {
		input,
		output: tokensOut,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + tokensOut,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

const BASE = { api: "cloudflare-workers-ai", provider: "cloudflare", model: CLAIRIC } as const;
const TOO_LONG = /too long|too many tokens|context length|request body/i;

function failure(message: string, milliseconds: number, usage?: DecisionUsage): DecisionResult {
	return {
		...BASE,
		decisionAnswers: {},
		...(usage === undefined ? {} : { decisionUsage: usage }),
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
		tooLong: TOO_LONG.test(message),
		milliseconds,
	};
}

/** The result of Clairic's output, with each answer under its question's id. */
function resultOf(
	raw: unknown,
	fields: ReadonlyMap<string, Field>,
	milliseconds: number,
	keepTruncated: boolean,
): DecisionResult {
	const parsed = outputSchema.safeParse(raw);
	if (!parsed.success) return failure(`Clairic gave an unexpected output: ${parsed.error.message}`, milliseconds);
	const output = parsed.data;
	const usage = usageOf(output);
	// A truncated state may have lost the values, so a smaller view must be sent.
	if (output.truncated && !keepTruncated) {
		return { ...failure("the text was too long for Clairic", milliseconds, usage), tooLong: true };
	}
	const answers: Answers = Object.fromEntries(
		Object.entries(output.answers).flatMap(([name, answer]) => {
			const id = fields.get(name)?.id;
			return id === undefined ? [] : [[id, answerOf(answer)] as const];
		}),
	);
	return {
		...BASE,
		decisionAnswers: answers,
		decisionUsage: usage,
		stopReason: "stop",
		timestamp: Date.now(),
		tooLong: false,
		milliseconds,
	};
}

/** A question for Clairic: its id, and the value question under that id. */
interface Field {
	readonly id: string;
	readonly question: ValueQuestion;
}

/** The value questions of a request by Clairic's field names, or the ids of the questions that are not value questions. */
function fieldsOf(request: DecisionRequest): Map<string, Field> | string[] {
	const entries = Object.entries(request.decisionQuestions);
	const others = entries.flatMap(([id, question]) => (question.type === "value" ? [] : [id]));
	if (others.length > 0) return others;
	const questions = new Map(entries.flatMap(([id, question]) => (question.type === "value" ? [[id, question]] : [])));
	return new Map(
		[...fieldNames(entries.map(([id]) => id))].flatMap(([name, id]) => {
			const question = questions.get(id);
			return question === undefined ? [] : [[name, { id, question }] as const];
		}),
	);
}

/**
 * A decider for Cloudflare's Clairic, which answers value questions only: it reads the request's `extractText`, and
 * its text answers are spans of it. `run` is `env.AI.run` in a Worker, or `cloudflareRest` outside one.
 */
export function clairicDecider(options: ClairicOptions): Decider {
	const now = options.now ?? Date.now;
	return {
		model: "cloudflare/clairic",
		window: WINDOW,
		charsPerToken: options.charsPerToken ?? 4,
		async decide(request) {
			const fields = fieldsOf(request);
			if (Array.isArray(fields)) return failure(`Clairic answers only value questions, not ${fields.join(", ")}`, 0);
			const started = now();
			try {
				const raw = await options.run(CLAIRIC, inputOf(request, fields));
				return resultOf(raw, fields, now() - started, options.truncated === "keep");
			} catch (error: unknown) {
				return failure(error instanceof Error ? error.message : String(error), now() - started);
			}
		},
	};
}
