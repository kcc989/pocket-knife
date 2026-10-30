import { describe, expect, it } from "vitest";
import { cloudflareRest } from "../../src/models/index.ts";

/** A fake fetch that answers each call with the next of `replies`: a status and a body, or an error to throw. */
function fakeFetch(replies: readonly ({ status: number; body: unknown } | Error)[]) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const send = (url: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		const reply = replies[calls.length - 1] ?? new Error("no more replies");
		if (reply instanceof Error) return Promise.reject(reply);
		const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
		return Promise.resolve(new Response(text, { status: reply.status }));
	};
	return { calls, send: send as unknown as typeof fetch };
}

const INPUT = { model: "clairic", state: "x", fields: { a: { type: "text" } } } as const;
const options = { accountId: "acct", apiToken: "token", sleep: () => Promise.resolve() };

describe("cloudflareRest", () => {
	it("posts the input to the model's run URL and gives the output from Cloudflare's envelope", async () => {
		const fake = fakeFetch([
			{ status: 200, body: { success: true, result: { answers: {} }, errors: [], messages: [] } },
		]);
		const run = cloudflareRest({ ...options, fetch: fake.send });
		await expect(run("@cf/cloudflare/clairic", INPUT)).resolves.toEqual({ answers: {} });
		expect(fake.calls[0]?.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clairic",
		);
		expect(fake.calls[0]?.init).toMatchObject({
			method: "POST",
			headers: { authorization: "Bearer token", "content-type": "application/json" },
			body: JSON.stringify(INPUT),
		});
	});

	it("fails with Cloudflare's error messages, as the live API gives them", async () => {
		const errors = [{ message: "AiError: list a needs items", code: 3030 }];
		const fake = fakeFetch([
			{ status: 400, body: { errors, success: false, result: {}, messages: [] } },
			{ status: 400, body: { success: false, result: {} } },
			{ status: 200, body: "not json" },
		]);
		const run = cloudflareRest({ ...options, fetch: fake.send });
		await expect(run("m", INPUT)).rejects.toThrow("Cloudflare answered HTTP 400: AiError: list a needs items");
		await expect(run("m", INPUT)).rejects.toThrow("Cloudflare answered HTTP 400: no error message");
		await expect(run("m", INPUT)).rejects.toThrow("Cloudflare answered HTTP 200 with an unexpected body");
		expect(fake.calls).toHaveLength(3);
	});

	it("retries a rate limit, a server error and a lost connection, up to its retries", async () => {
		const ok = { status: 200, body: { success: true, result: 1 } };
		const waits: number[] = [];
		const sleep = (ms: number) => {
			waits.push(ms);
			return Promise.resolve();
		};
		const fake = fakeFetch([{ status: 429, body: {} }, new Error("reset"), ok]);
		await expect(cloudflareRest({ ...options, sleep, fetch: fake.send })("m", INPUT)).resolves.toBe(1);
		expect(waits).toEqual([1000, 2000]);
		const down = fakeFetch([
			{ status: 503, body: {} },
			{ status: 502, body: {} },
		]);
		await expect(cloudflareRest({ ...options, retries: 1, fetch: down.send })("m", INPUT)).rejects.toThrow(
			"Cloudflare answered HTTP 502",
		);
		const lost = fakeFetch([new Error("reset")]);
		await expect(cloudflareRest({ ...options, retries: 0, fetch: lost.send })("m", INPUT)).rejects.toThrow("reset");
	});
});
