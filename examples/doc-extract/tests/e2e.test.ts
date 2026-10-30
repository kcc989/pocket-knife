import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTrace } from "@osolmaz/switch";
import { readRunRecord, resultSchema, runCases } from "@osolmaz/switch/cli";
import { routedDecider } from "@osolmaz/switch/models";
import { fakeDecider } from "@osolmaz/switch/testing";
import { loadExpected } from "../src/case.ts";
import { scoreOutcome, summary } from "../src/score.ts";
import { docExtractSetup } from "../src/setup.ts";
import { keywordPicker, sentenceExtractor } from "./helpers/standins.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const CASES = ["invoice", "notice", "receipt"].map((id) => join(ROOT, "cases", id));

let out = "";
beforeEach(async () => {
	out = await mkdtemp(join(tmpdir(), "doc-extract-"));
});
afterEach(async () => {
	await rm(out, { recursive: true, force: true });
});

const resultOf = async (run: string, id: string) =>
	resultSchema.parse(JSON.parse(await readFile(join(run, "cases", id, "result.json"), "utf8")));

/** The stand-in models: a keyword picker for the decision model and a sentence matcher for the extractor. */
const standIns = () => {
	const decide = fakeDecider(keywordPicker);
	const extract = fakeDecider(sentenceExtractor, 65_536);
	return { decide, extract, routed: routedDecider({ decide, extract }) };
};

describe("the doc-extract harness, with stand-in models", () => {
	it("runs the three local cases into a run folder, and each outcome matches its answer key", async () => {
		const { decide, extract, routed } = standIns();
		const run = join(out, "run");
		await runCases(await docExtractSetup(), CASES, routed, { out: run, concurrency: 2, progress: () => undefined });
		for (const folder of CASES) {
			const id = folder.split("/").at(-1) ?? "";
			const result = await resultOf(run, id);
			expect(result, id).toMatchObject({ ended: "done", thrown: null });
			const scores = scoreOutcome(result.outcome, (await loadExpected(folder)).values);
			expect(summary(scores), id).toMatchObject({ accuracy: 1, wrongFound: 0 });
		}
		const receipt = await resultOf(run, "receipt");
		expect(receipt.outcome).toMatchObject({
			values: { loyalty_number: { value: null, status: "doubtful" }, total_paid: { value: 31.48, status: "found" } },
			stopped: true,
		});
		const notice = await resultOf(run, "notice");
		expect(notice.outcome).toMatchObject({ partsRead: 1, parts: 5, found: 3, doubtful: 0 });
		const trace = parseTrace(await readFile(join(run, "cases", "notice", "trace.jsonl"), "utf8"));
		const states = trace.flatMap((entry) => (entry.type === "state" ? [entry.state] : []));
		// Only part 4, the rent, is read: the filler parts before and after it are skipped.
		expect(states.at(-1)?.["read"]).toEqual([3]);
		expect(decide.requests.every((request) => request.extractText === undefined)).toBe(true);
		expect(extract.requests.length).toBeGreaterThan(0);
		const record = await readRunRecord(run);
		expect(record.model).toBe("fake/decider+fake/decider");
		expect(record.totals?.failed).toBe(0);
	});

	it("replays a trace through the command line with the same outcome and no model call", async () => {
		const run = join(out, "run");
		await runCases(await docExtractSetup(), [CASES[0] ?? ""], standIns().routed, {
			out: run,
			concurrency: 1,
			progress: () => undefined,
		});
		const original = await resultOf(run, "invoice");
		const replayed = join(out, "replay");
		const trace = join(run, "cases", "invoice", "trace.jsonl");
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--conditions=switch-source",
				join(ROOT, "src", "main.ts"),
				"replay",
				CASES[0] ?? "",
				trace,
				"--out",
				replayed,
			],
			{ env: { ...process.env, TYPESAFE_API_KEY: "", CLOUDFLARE_API_TOKEN: "" } },
		);
		const again = resultSchema.parse(JSON.parse(stdout));
		expect(again).toMatchObject({ ended: "done", thrown: null, steps: original.steps });
		expect(again.outcome).toEqual(original.outcome);
		expect(await readFile(join(replayed, "cases", "invoice", "requests.jsonl"), "utf8")).toBe("");
		expect((await readRunRecord(replayed)).totals?.requests).toBe(0);
	}, 30_000);
});
