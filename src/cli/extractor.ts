import { InvalidArgumentError } from "commander";
import type { Decider } from "../core/index.ts";
import { clairicDecider } from "../models/clairic.ts";
import { cloudflareRest } from "../models/cloudflare.ts";
import { routedDecider } from "../models/routed.ts";

/** The extractors that `--extractor` names, with the environment variables that each one needs. */
const EXTRACTORS = {
	"cloudflare/clairic": ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
} as const;

type Env = Readonly<Record<string, string | undefined>>;

/** The value of each of `names` in `env`, without the white space around it; it fails on one that is missing. */
function required(env: Env, names: readonly string[]): string[] {
	return names.map((name) => {
		const value = env[name]?.trim();
		if (value === undefined || value === "")
			throw new InvalidArgumentError(`the environment variable ${name} is not set`);
		return value;
	});
}

/** The extractor that `name` names, with its keys from `env`. */
export function extractorNamed(name: string, env: Env): Decider {
	if (!Object.hasOwn(EXTRACTORS, name)) {
		throw new InvalidArgumentError(`no extractor ${name}; known: ${Object.keys(EXTRACTORS).join(", ")}`);
	}
	const [accountId = "", apiToken = ""] = required(env, EXTRACTORS["cloudflare/clairic"]);
	return clairicDecider({ run: cloudflareRest({ accountId, apiToken }) });
}

/** `decider`, with the value questions sent to the extractor that `name` names; `decider` itself without a name. */
export function withExtractor(decider: Decider, name: string | undefined, env: Env): Decider {
	return name === undefined ? decider : routedDecider({ decide: decider, extract: extractorNamed(name, env) });
}
