import { describe, expect, it } from "vitest";
import type { DecisionRequest } from "../../src/core/index.ts";
import { type ClairicInput, clairicDecider, fieldNames } from "../../src/models/index.ts";

/** A fake `env.AI.run` that keeps every input and gives `output`, or throws it when it is an error. */
function fakeRun(output: unknown) {
	const inputs: { model: string; input: ClairicInput }[] = [];
	const run = (model: string, input: ClairicInput) => {
		inputs.push({ model, input });
		return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
	};
	return { inputs, run };
}

/** Clairic's output for the docs' example, as the live API gave it on 2026-10-30. */
const OUTPUT = {
	model: "clairic",
	answers: {
		order_number: {
			type: "text",
			p_null: 5.5e-6,
			span: [8, 16],
			guess: "ORD-2291",
			confidence: 0.99998,
			value: "ORD-2291",
		},
		q1: { type: "number", p_null: 1e-6, guess: 1080, confidence: 0.9999, value: 1080, source: "image", span: null },
		contacts: {
			type: "list",
			value: ["Dana Ruiz", "Priya Shah"],
			spans: [
				[120, 129],
				[131, 141],
			],
			confidence: 0.99,
		},
		po_number: { type: "text", p_null: 0.99, span: [8, 16], guess: "ORD-2291", confidence: 0.999, value: null },
		pay: { type: "estimate", value: 31, mean: 30.7, median: 31, p10: 25, p90: 36, p_below: 1e-6, p_above: 3e-6 },
	},
	truncated: false,
	usage: { state_tokens: 61, image_tokens: 0, schema_tokens: 486, input_tokens: 2_000_000, output_tokens: 0 },
};

const request: DecisionRequest = {
	decisionState: { part: "Order" },
	extractText: "Order ORD-2291 from Northwind Supply",
	decisionImages: [{ type: "image", label: "page 1", mimeType: "image/png", data: "AAAA" }],
	decisionQuestions: {
		order_number: { type: "value", kind: "text", instructions: "The order number" },
		"total due": { type: "value", kind: "number", instructions: "Amount due", field: { decimals: 2, unit: "USD" } },
		contacts: { type: "value", kind: "list", instructions: "Contacts", field: { items: "text" } },
		po_number: { type: "value", kind: "text", instructions: "Purchase order number", data: { note: "not sent" } },
		pay: { type: "value", kind: "estimate", instructions: "Days to pay", field: { min: 0, max: 120 } },
	},
};

describe("clairicDecider", () => {
	it("sends value questions as Clairic's fields, over the text to extract from and the images as data URLs", async () => {
		const fake = fakeRun(OUTPUT);
		const decider = clairicDecider({ run: fake.run });
		expect(decider).toMatchObject({ model: "cloudflare/clairic", window: 65_536, charsPerToken: 2.3 });
		await decider.decide(request);
		expect(fake.inputs).toEqual([
			{
				model: "@cf/cloudflare/clairic",
				input: {
					model: "clairic",
					state: "Order ORD-2291 from Northwind Supply",
					images: ["data:image/png;base64,AAAA"],
					fields: {
						order_number: { type: "text", instructions: "The order number" },
						q1: { type: "number", instructions: "Amount due", decimals: 2, unit: "USD" },
						contacts: { type: "list", instructions: "Contacts", items: "text" },
						po_number: { type: "text", instructions: "Purchase order number" },
						pay: { type: "estimate", instructions: "Days to pay", min: 0, max: 120 },
					},
				},
			},
		]);
	});

	it("gives Clairic's answers as value answers under their question ids, with the cost of the input tokens", async () => {
		let clock = 0;
		const decider = clairicDecider({ run: fakeRun(OUTPUT).run, now: () => (clock += 40) });
		const result = await decider.decide(request);
		expect(result).toMatchObject({
			stopReason: "stop",
			tooLong: false,
			milliseconds: 40,
			model: "@cf/cloudflare/clairic",
		});
		expect(result.decisionAnswers).toEqual({
			order_number: {
				type: "value",
				kind: "text",
				value: "ORD-2291",
				guess: "ORD-2291",
				pNull: 5.5e-6,
				confidence: 0.99998,
				span: [8, 16],
			},
			"total due": { type: "value", kind: "number", value: 1080, guess: 1080, pNull: 1e-6, confidence: 0.9999 },
			contacts: {
				type: "value",
				kind: "list",
				value: ["Dana Ruiz", "Priya Shah"],
				spans: [
					[120, 129],
					[131, 141],
				],
				confidence: 0.99,
			},
			po_number: {
				type: "value",
				kind: "text",
				value: null,
				guess: "ORD-2291",
				pNull: 0.99,
				confidence: 0.999,
				span: [8, 16],
			},
			pay: { type: "value", kind: "estimate", value: 31, median: 31, p10: 25, p90: 36 },
		});
		expect(result.decisionUsage).toEqual({
			input: 2_000_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2_000_000,
			cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
		});
	});

	it("reads the decision state as JSON when the request has no text to extract from", async () => {
		const fake = fakeRun({ ...OUTPUT, answers: {} });
		await clairicDecider({ run: fake.run }).decide({
			decisionState: request.decisionState,
			decisionQuestions: request.decisionQuestions,
		});
		expect(fake.inputs[0]?.input.state).toBe('{"part":"Order"}');
		expect(fake.inputs[0]?.input).not.toHaveProperty("images");
	});

	it("reports a truncated text as too long, so the loop can send a smaller view", async () => {
		const result = await clairicDecider({ run: fakeRun({ ...OUTPUT, truncated: true }).run }).decide(request);
		expect(result).toMatchObject({ stopReason: "error", tooLong: true, decisionAnswers: {} });
		expect(result.decisionUsage?.input).toBe(2_000_000);
	});

	it("fails a request whose call throws or whose output is not Clairic's", async () => {
		const thrown = await clairicDecider({ run: fakeRun(new Error("request body too long")).run }).decide(request);
		expect(thrown).toMatchObject({ stopReason: "error", errorMessage: "request body too long", tooLong: true });
		const odd = await clairicDecider({ run: fakeRun({ answers: [] }).run }).decide(request);
		expect(odd.errorMessage).toMatch(/^Clairic gave an unexpected output/);
		const rejected = await clairicDecider({
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a run may reject with a value that is not an Error.
			run: () => Promise.reject("down"),
		}).decide(request);
		expect(rejected.errorMessage).toBe("down");
	});

	it("refuses questions that are not value questions, without a call", async () => {
		const fake = fakeRun(OUTPUT);
		const result = await clairicDecider({ run: fake.run }).decide({
			decisionState: {},
			decisionQuestions: { b: { type: "bool", instructions: "B?", criteria: { true: "yes", false: "no" } } },
		});
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Clairic answers only value questions, not b",
		});
		expect(fake.inputs).toEqual([]);
	});
});

describe("fieldNames", () => {
	it("keeps the ids that Clairic takes as field names, and names the others by their place", () => {
		expect(fieldNames(["a.b-c_1", "1st", "x y", "q1"])).toEqual(
			new Map([
				["a.b-c_1", "a.b-c_1"],
				["q1", "1st"],
				["q2", "x y"],
				["q3", "q1"],
			]),
		);
		expect(fieldNames(["n".repeat(65)])).toEqual(new Map([["q0", "n".repeat(65)]]));
	});
});
