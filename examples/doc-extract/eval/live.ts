/**
 * The live eval of doc-extract. It makes paid model calls, with keys from the environment only.
 *
 *   node --conditions=switch-source eval/live.ts smoke --out <folder>
 *   node --conditions=switch-source eval/live.ts prepare --out <folder>
 *   node --conditions=switch-source eval/live.ts def14a --out <folder> [--set dev|holdout|all] [--readers a,b] [--yes]
 *
 * smoke runs the local cases with Jev and Clairic. def14a downloads each filing in eval/def14a from EDGAR, splits it
 * into parts, and compares three readers on it. Both need TYPESAFE_API_KEY, CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN; def14a also needs SEC_USER_AGENT (a name and an email, as the SEC asks) and MISTRAL_API_KEY.
 * Node's fetch uses a proxy only with NODE_USE_ENV_PROXY=1.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Json, JsonObject } from "@osolmaz/switch";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { clairicDecider, cloudflareRest, piAiDecider, routedDecider } from "@osolmaz/switch/models";
import { z } from "zod";
import {
	calibration,
	type FieldScore,
	htmlToMarkdown,
	loadExpected,
	scoreOutcome,
	splitParts,
	summary,
} from "../src/index.ts";
import { DEF14A_CHECKED_FIELDS, DEF14A_CHECKS, DEF14A_FIELDS } from "./fields.ts";
import { navigated, type Reading, structuredLlm, wholeClairic } from "./readers.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const { positionals, values: flags } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: "string" },
		yes: { type: "boolean", default: false },
		set: { type: "string", default: "all" },
		readers: { type: "string", default: "" },
	},
});

function env(name: string): string {
	const value = process.env[name]?.trim();
	if (value === undefined || value === "") throw new Error(`set ${name}`);
	return value;
}

/** Jev and Clairic; `truncated` is what Clairic gives for a text longer than its window. */
const routed = (truncated: "fail" | "keep" = "fail") =>
	routedDecider({
		decide: piAiDecider("typesafe/jev-latest", { registry: builtinModels() }),
		extract: clairicDecider({
			run: cloudflareRest({ accountId: env("CLOUDFLARE_ACCOUNT_ID"), apiToken: env("CLOUDFLARE_API_TOKEN") }),
			truncated,
		}),
	});

/** One filing of the DEF 14A set. */
const filingSchema = z.object({
	id: z.string(),
	company: z.string(),
	cik: z.string(),
	accession: z.string(),
	document: z.string(),
	/** "dev" filings were looked at while the harness was built; "holdout" filings only measure it. */
	set: z.enum(["dev", "holdout"]),
});
type Filing = z.infer<typeof filingSchema>;

/** The filing's HTML from EDGAR, kept in `cache` so that a second run downloads nothing. */
async function download(filing: Filing, cache: string): Promise<string> {
	const file = join(cache, `${filing.id}.htm`);
	const kept = await readFile(file, "utf8").catch(() => null);
	if (kept !== null) return kept;
	const url = `https://www.sec.gov/Archives/edgar/data/${String(Number(filing.cik))}/${filing.accession.replace(/-/g, "")}/${filing.document}`;
	const response = await fetch(url, { headers: { "user-agent": env("SEC_USER_AGENT") } });
	if (!response.ok) throw new Error(`EDGAR answered HTTP ${String(response.status)} for ${url}`);
	const html = await response.text();
	await mkdir(cache, { recursive: true });
	await writeFile(file, html);
	return html;
}

/** Writes a filing's case folder: case.json with the DEF 14A fields, and the filing as Markdown. */
/**
 * The least text of a navigated read. Clairic reads a long text with every field in one pass,
 * but a text shorter than about 32,000 characters in a pass for every few fields, billing the text each time.
 */
const READ_CHARS = 40_000;

/** The settings of each Clairic reader that the harness runs, by the reader's name. */
const STRATEGIES = {
	"whole-checked": { strategy: "whole", fields: DEF14A_CHECKED_FIELDS, checks: DEF14A_CHECKS },
	"navigated-checked": {
		strategy: "navigate",
		readChars: READ_CHARS,
		finalRead: true,
		fields: DEF14A_CHECKED_FIELDS,
		checks: DEF14A_CHECKS,
	},
} as const;

/** Writes a filing's case folders, one for each strategy: case.json with the DEF 14A fields, and the filing as Markdown. */
async function caseFolder(filing: Filing, out: string): Promise<{ folders: Record<string, string>; text: string }> {
	const text = htmlToMarkdown(await download(filing, join(out, "filings")));
	const folders: Record<string, string> = {};
	for (const [reader, settings] of Object.entries(STRATEGIES)) {
		const folder = join(out, "cases", reader, filing.id);
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, "case.json"), JSON.stringify({ id: filing.id, ...settings }, null, 1));
		await writeFile(join(folder, "document.md"), text);
		folders[reader] = folder;
	}
	return { folders, text };
}

/** About as many characters as Clairic's window of 65,536 tokens holds. */
const CLAIRIC_CHARS = 150_000;

const LLM = {
	model: process.env["LLM_MODEL"] ?? "mistral-large-latest",
	price: {
		input: Number(process.env["LLM_PRICE_INPUT"] ?? "0.5"),
		output: Number(process.env["LLM_PRICE_OUTPUT"] ?? "1.5"),
	},
	maxChars: 600_000,
};

/** The estimated cost of the def14a eval, before any call: every reader reads every filing once. */
function estimate(texts: readonly string[]): number {
	const chars = texts.reduce((sum, text) => sum + text.length, 0);
	const clairic = (Math.min(chars, texts.length * CLAIRIC_CHARS) / 2.3) * 0.1;
	const llm = (Math.min(chars, texts.length * LLM.maxChars) / 3.5) * LLM.price.input;
	// The whole-checked reader reads the text once more, and the navigated one may read it twice.
	return (clairic * 4 + llm) / 1_000_000;
}

interface Row {
	readonly filing: string;
	readonly reader: string;
	readonly reading: Reading;
	readonly scores: FieldScore[];
}

async function readAll(filing: Filing, folders: Record<string, string>, text: string, out: string): Promise<Row[]> {
	const expected = (await loadExpected(join(ROOT, "eval", "def14a", filing.id))).values;
	const run = cloudflareRest({ accountId: env("CLOUDFLARE_ACCOUNT_ID"), apiToken: env("CLOUDFLARE_API_TOKEN") });
	const llm = { ...LLM, apiKey: process.env["MISTRAL_API_KEY"] ?? "set-by-proxy" };
	const readers: [string, () => Promise<Reading>][] = [
		["whole-clairic", () => wholeClairic(run, text, DEF14A_FIELDS)],
		...Object.entries(folders).map(([reader, folder]): [string, () => Promise<Reading>] => [
			reader,
			() => {
				const truncated = reader.startsWith("whole") ? "keep" : "fail";
				return navigated(
					routed(truncated),
					folder,
					join(out, "runs", reader, `${filing.id}-${String(Date.now())}`),
				);
			},
		]),
		["structured-llm", () => structuredLlm(llm, text, DEF14A_FIELDS)],
	];
	const rows: Row[] = [];
	const only = flags.readers === "" ? null : flags.readers.split(",");
	for (const [reader, read] of readers.filter(([name]) => only === null || only.includes(name))) {
		const reading = await read();
		rows.push({ filing: filing.id, reader, reading, scores: scoreOutcome({ values: reading.values }, expected) });
		process.stderr.write(`${filing.id} ${reader}: ${JSON.stringify(summary(rows.at(-1)?.scores ?? []))}\n`);
	}
	return rows;
}

async function filingsOf(): Promise<Filing[]> {
	const set = join(ROOT, "eval", "def14a");
	const entries = await readdir(set, { withFileTypes: true });
	const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	const filings = await Promise.all(
		ids.map(async (id) => filingSchema.parse(JSON.parse(await readFile(join(set, id, "filing.json"), "utf8")))),
	);
	return filings.filter((filing) => flags.set === "all" || filing.set === flags.set);
}

/** Downloads and splits every filing, with no model call: what a person reads to label it. */
async function prepare(out: string): Promise<JsonObject> {
	const sizes: Record<string, Json> = {};
	for (const filing of await filingsOf()) {
		const { text } = await caseFolder(filing, out);
		sizes[filing.id] = { chars: text.length, parts: splitParts(text).length };
	}
	return sizes;
}

async function def14a(out: string): Promise<JsonObject> {
	const filings = await filingsOf();
	const folders = [];
	for (const filing of filings) folders.push({ filing, ...(await caseFolder(filing, out)) });
	const cost = estimate(folders.map((entry) => entry.text));
	process.stderr.write(`estimated cost: $${cost.toFixed(2)}\n`);
	if (cost > 5 && !flags.yes) throw new Error("the eval would cost more than $5; pass --yes to run it");
	const rows: Row[] = [];
	for (const { filing, folders: own, text } of folders) rows.push(...(await readAll(filing, own, text, out)));
	return reportOf(rows);
}

const mean = (numbers: readonly number[]): number =>
	numbers.length === 0 ? 0 : numbers.reduce((a, b) => a + b, 0) / numbers.length;

/** Per reader: the totals over every field of every filing, the means per filing, and the calibration buckets. */
function reportOf(rows: readonly Row[]): JsonObject {
	const readers = [...new Set(rows.map((row) => row.reader))];
	const perReader = readers.map((reader) => {
		const own = rows.filter((row) => row.reader === reader);
		const readings = own.map((row) => row.reading);
		return {
			reader,
			...summary(own.flatMap((row) => row.scores)),
			partsReadPerFiling: mean(readings.map((reading) => reading.partsRead ?? 0)),
			inputTokensPerFiling: mean(readings.map((reading) => reading.inputTokens)),
			decideTokensPerFiling: mean(readings.map((reading) => reading.decideTokens)),
			costPerFiling: mean(readings.map((reading) => reading.cost)),
			secondsPerFiling: mean(readings.map((reading) => reading.milliseconds / 1000)),
			truncated: readings.filter((reading) => reading.truncated).length,
			calibration: calibration(own.flatMap((row) => row.scores)),
		};
	});
	const filings = rows.map((row) => ({
		filing: row.filing,
		reader: row.reader,
		...summary(row.scores),
		partsRead: row.reading.partsRead,
		inputTokens: row.reading.inputTokens,
		cost: row.reading.cost,
		truncated: row.reading.truncated,
		error: row.reading.error,
		values: row.reading.values,
		misses: row.scores
			.filter((score) => !score.correct)
			.map((score) => ({
				field: score.field,
				expected: score.expected,
				value: score.value,
				status: score.status,
				confidence: score.confidence,
			})),
	}));
	const total = rows.reduce((sum, row) => sum + row.reading.cost, 0);
	return { readers: perReader, filings, totalCost: total };
}

async function smoke(out: string): Promise<JsonObject> {
	const reading: Record<string, Json> = {};
	for (const id of ["invoice", "notice", "receipt"]) {
		const result = await navigated(routed(), join(ROOT, "cases", id), join(out, "smoke"));
		const scores = scoreOutcome({ values: result.values }, (await loadExpected(join(ROOT, "cases", id))).values);
		const pass = scores.every((score) => score.correct || score.status === "doubtful");
		reading[id] = {
			pass,
			...summary(scores),
			partsRead: result.partsRead,
			cost: result.cost,
			inputTokens: result.inputTokens,
		};
	}
	return reading;
}

const out = flags.out ?? join(ROOT, "out", "eval");
await mkdir(out, { recursive: true });
const mode = positionals[0];
const MODES: Readonly<Record<string, (folder: string) => Promise<JsonObject>>> = { smoke, prepare, def14a };
const chosen = mode === undefined ? undefined : MODES[mode];
if (chosen === undefined) throw new Error("name the eval: smoke, prepare or def14a");
const report = await chosen(out);
await writeFile(join(out, `${mode}.json`), `${JSON.stringify(report, null, 1)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
