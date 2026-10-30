import { describe, expect, it } from "vitest";
import { extractorNamed, withExtractor } from "../../src/cli/extractor.ts";
import { fakeDecider, answering } from "../helpers/fakes.ts";

const ENV = { CLOUDFLARE_ACCOUNT_ID: " acct ", CLOUDFLARE_API_TOKEN: "token" };

describe("--extractor", () => {
	it("names Clairic on Cloudflare, with its keys from the environment", () => {
		expect(extractorNamed("cloudflare/clairic", ENV)).toMatchObject({ model: "cloudflare/clairic", window: 65_536 });
		expect(() => extractorNamed("cloudflare/clairic", { CLOUDFLARE_ACCOUNT_ID: "acct" })).toThrow(
			"the environment variable CLOUDFLARE_API_TOKEN is not set",
		);
		expect(() => extractorNamed("other/model", ENV)).toThrow("no extractor other/model; known: cloudflare/clairic");
	});

	it("routes the value questions to the extractor, and leaves the decider as it is without one", () => {
		const decider = fakeDecider(answering(0.5));
		expect(withExtractor(decider, undefined, ENV)).toBe(decider);
		expect(withExtractor(decider, "cloudflare/clairic", ENV).model).toBe("fake/decider+cloudflare/clairic");
	});
});
