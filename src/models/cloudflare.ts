import { z } from "zod";
import type { AiRun } from "./clairic.ts";

export interface CloudflareRestOptions {
	readonly accountId: string;
	readonly apiToken: string;
	readonly timeoutMs?: number;
	/** Retries after a rate limit, a server error or a lost connection. */
	readonly retries?: number;
	readonly fetch?: typeof fetch;
	/** Waits between retries; tests pass one that does not wait. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/** Cloudflare's API envelope: the model's output is in `result`, and a failed call lists its errors. */
const envelopeSchema = z.object({
	success: z.boolean(),
	result: z.unknown(),
	errors: z.array(z.object({ message: z.string(), code: z.number().optional() })).default([]),
});

/** A failed call that may pass when it is sent again. */
class TransientError extends Error {
	override readonly name = "TransientError";
}

const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/** The model's output from a response, or an error that says why there is none. */
async function outputOf(response: Response): Promise<unknown> {
	const status = String(response.status);
	const body = envelopeSchema.safeParse(await response.json().catch(() => null));
	if (response.status === 429 || response.status >= 500)
		throw new TransientError(`Cloudflare answered HTTP ${status}`);
	if (!body.success) throw new Error(`Cloudflare answered HTTP ${status} with an unexpected body`);
	if (!body.data.success) {
		const messages = body.data.errors.map((error) => error.message).join("; ");
		throw new Error(`Cloudflare answered HTTP ${status}: ${messages === "" ? "no error message" : messages}`);
	}
	return body.data.result;
}

/** Runs Workers AI models over Cloudflare's REST API, which `env.AI.run` stands for outside a Worker. */
export function cloudflareRest(options: CloudflareRestOptions): AiRun {
	const send = options.fetch ?? fetch;
	const sleep = options.sleep ?? wait;
	const retries = options.retries ?? 2;
	const base = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/`;
	const once = async (model: string, inputs: unknown): Promise<unknown> => {
		const response = await send(`${base}${model}`, {
			method: "POST",
			headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" },
			body: JSON.stringify(inputs),
			signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
		}).catch((error: unknown) => {
			throw new TransientError(error instanceof Error ? error.message : String(error));
		});
		return outputOf(response);
	};
	return async (model, inputs) => {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await once(model, inputs);
			} catch (error: unknown) {
				if (!(error instanceof TransientError) || attempt >= retries) throw error;
				await sleep(1000 * 2 ** attempt);
			}
		}
	};
}
