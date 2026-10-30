import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Decider, type Json, type JsonObject, parseRequests, VALUE_KINDS } from "@osolmaz/switch";
import { resultSchema, runCases } from "@osolmaz/switch/cli";
import { type AiRun, CLAIRIC, CLAIRIC_PRICE, fieldNames } from "@osolmaz/switch/models";
import { z } from "zod";
import { docExtractSetup, type FieldSpec, isFound } from "../src/index.ts";

/** What one reader gave for one case: the values as the domain's outcome has them, and what it cost. */
export interface Reading {
	readonly values: JsonObject;
	readonly inputTokens: number;
	/** Of which the decision model's, for the navigated reader. */
	readonly decideTokens: number;
	readonly cost: number;
	readonly milliseconds: number;
	readonly partsRead: number | null;
	/** The text did not fit the reader's window, so the reader saw only its start. */
	readonly truncated: boolean;
	readonly error: string | null;
}

const reported = (value: Json | undefined, confidence: number | null, found: boolean): JsonObject => ({
	value: value ?? null,
	status: found ? "found" : "doubtful",
	confidence,
});

const json: z.ZodType<Json> = z.json();

const clairicOutput = z.object({
	answers: z.record(
		z.string(),
		z.object({
			value: json,
			confidence: z.number().optional(),
			p_null: z.number().optional(),
			type: z.enum(VALUE_KINDS),
		}),
	),
	truncated: z.boolean(),
	usage: z.object({ input_tokens: z.number() }),
});

/** Reader 1: the whole document to Clairic in one call, with every field. */
export async function wholeClairic(
	run: AiRun,
	text: string,
	fields: Readonly<Record<string, FieldSpec>>,
): Promise<Reading> {
	const names = fieldNames(Object.keys(fields));
	const specs = Object.fromEntries(
		[...names].map(([name, id]) => {
			const spec = fields[id];
			return [name, { ...spec?.field, type: spec?.kind ?? "text", instructions: spec?.instructions ?? id }];
		}),
	);
	const started = Date.now();
	const output = clairicOutput.parse(await run(CLAIRIC, { model: "clairic", state: text, fields: specs }));
	const values = Object.fromEntries(
		[...names].map(([name, id]) => {
			const answer = output.answers[name];
			const found =
				answer !== undefined &&
				isFound({ value: answer.value, confidence: answer.confidence, pNull: answer.p_null });
			return [id, reported(answer?.value, answer?.confidence ?? null, found)];
		}),
	);
	const tokens = output.usage.input_tokens;
	return {
		values,
		inputTokens: tokens,
		decideTokens: 0,
		cost: tokens * CLAIRIC_PRICE,
		milliseconds: Date.now() - started,
		partsRead: null,
		truncated: output.truncated,
		error: null,
	};
}

/** Reader 2: the doc-extract harness, where the decision model picks the parts that Clairic reads. */
export async function navigated(decider: Decider, folder: string, out: string): Promise<Reading> {
	const id = folder.split("/").at(-1) ?? "";
	const started = Date.now();
	await runCases(await docExtractSetup(), [folder], decider, { out, concurrency: 1, progress: () => undefined });
	const result = resultSchema.parse(JSON.parse(await readFile(join(out, "cases", id, "result.json"), "utf8")));
	const requests = parseRequests(await readFile(join(out, "cases", id, "requests.jsonl"), "utf8"));
	const usageOf = (api: string) =>
		requests
			.filter((request) => request.result.api.startsWith(api))
			.reduce((sum, request) => sum + (request.result.decisionUsage?.input ?? 0), 0);
	const clairicTokens = usageOf("cloudflare");
	const decideTokens = usageOf("typesafe");
	const outcome = result.outcome ?? {};
	const values = (outcome["values"] ?? {}) as JsonObject;
	return {
		values,
		inputTokens: clairicTokens + decideTokens,
		decideTokens,
		cost: requests.reduce((sum, request) => sum + (request.result.decisionUsage?.cost.total ?? 0), 0),
		milliseconds: Date.now() - started,
		partsRead: typeof outcome["partsRead"] === "number" ? outcome["partsRead"] : null,
		truncated: false,
		error: result.thrown ?? result.error,
	};
}

export interface LlmOptions {
	readonly model: string;
	readonly apiKey: string;
	/** US dollars per million input and output tokens. */
	readonly price: { readonly input: number; readonly output: number };
	/** The most characters of the document to send, for the model's window. */
	readonly maxChars: number;
}

const llmReply = z.object({
	choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
	usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
});

/** The JSON schema of the reply: each field nullable, of its kind. */
function replySchema(fields: Readonly<Record<string, FieldSpec>>): JsonObject {
	const typeOf = (spec: FieldSpec) => (spec.kind === "number" ? "number" : "string");
	return {
		type: "object",
		additionalProperties: false,
		required: Object.keys(fields),
		properties: Object.fromEntries(
			Object.entries(fields).map(([name, spec]) => [
				name,
				{ type: [typeOf(spec), "null"], description: spec.instructions },
			]),
		),
	};
}

/** Reader 3: one LLM call with structured output, over Mistral's chat API. Every value it gives counts as found. */
export async function structuredLlm(
	options: LlmOptions,
	text: string,
	fields: Readonly<Record<string, FieldSpec>>,
): Promise<Reading> {
	const started = Date.now();
	const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
		method: "POST",
		headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: options.model,
			temperature: 0,
			response_format: {
				type: "json_schema",
				json_schema: { name: "values", strict: true, schema: replySchema(fields) },
			},
			messages: [
				{
					role: "system",
					content:
						"Read the document and give each value that it asks for. Give null for a value that the document does not state.",
				},
				{ role: "user", content: text.slice(0, options.maxChars) },
			],
		}),
	});
	if (!response.ok) throw new Error(`Mistral answered HTTP ${String(response.status)}: ${await response.text()}`);
	const reply = llmReply.parse(await response.json());
	const answers = z.record(z.string(), json).parse(JSON.parse(reply.choices[0]?.message.content ?? "{}"));
	const values = Object.fromEntries(
		Object.keys(fields).map((name) => [name, reported(answers[name], null, answers[name] != null)]),
	);
	const { prompt_tokens: input, completion_tokens: output } = reply.usage;
	return {
		values,
		inputTokens: input,
		decideTokens: 0,
		cost: (input * options.price.input + output * options.price.output) / 1_000_000,
		milliseconds: Date.now() - started,
		partsRead: null,
		truncated: text.length > options.maxChars,
		error: null,
	};
}
