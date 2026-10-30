# doc-extract eval

Run on 2026-10-30 with `typesafe/jev-latest` (served as jev-1.14.0), `@cf/cloudflare/clairic` and
`mistral-large-latest`.

## Verdict

| Pass condition                                                                   | Result   | Measured                                                    |
| -------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| `pnpm check` passes; the two no-network layers pass                              | **Pass** | format, lint, typecheck, coverage, DRY scan, slophammer     |
| Live smoke: every local case matches its key, or each miss is doubtful           | **Pass** | 11 of 11 values right; the absent loyalty number stays null |
| DEF 14A: navigated accuracy within 2 points of whole-document Clairic, or better | **Fail** | 39.0% vs 54.6%: 15.6 points lower                           |
| DEF 14A: navigated uses fewer input tokens per filing                            | **Fail** | 39,908 vs 37,164 (run 1: 31,917 vs 37,164, so it varies)    |
| DEF 14A: wrong values kept as "found" at most 2% of fields                       | **Fail** | navigated 7.3%, whole-document 5.4%                         |
| DEF 14A: values at 0.9+ confidence at least 90% right                            | **Fail** | navigated 72.7%, whole-document 82.0%                       |

No threshold, prompt or converter was changed after the DEF 14A run to make it pass. The one change between the two
DEF 14A runs was a scoring fix (see below); both runs fail the same conditions.

## Live smoke: the three local cases with Jev and Clairic

| Case    | Right  | Doubtful            | Parts read | Input tokens | Cost     |
| ------- | ------ | ------------------- | ---------- | ------------ | -------- |
| invoice | 4 of 4 | 0                   | 4 of 6     | 3,975        | $0.00014 |
| notice  | 3 of 3 | 0                   | 1 of 5     | 977          | $0.00003 |
| receipt | 4 of 4 | 1 (loyalty, null ✓) | 2 of 4     | 2,437        | $0.00008 |

The notice's filler parts were all skipped. The first live smoke run failed: Jev chose "stop" at 0.93 on the invoice
and the receipt under the first pick instructions. I changed the instructions once, before any DEF 14A run. Probes on the
recorded first requests: under the old wording Jev chose stop at 0.92 (invoice) and 0.88 (receipt); under the new
one it chose a part at 0.93 and 0.89.

## DEF 14A: three readers on five filings

Five 2026 proxy filings from EDGAR: National Presto (NPK), Winmark (WINA), Monarch Casino (MCRI), Badger Meter (BMI) and
Simpson Manufacturing (SSD). Each has 41 fields: name, title, salary, bonus, stock awards, option awards, non-equity
incentive pay and total for the first five named executives in the Summary Compensation Table, for the latest fiscal
year, and the CEO pay ratio. That is 205 fields; 24 are null because MCRI has 3 executives and WINA has 4. The Comped
golden cases could not serve as the key (one case, a 2014 Meta filing, with its compensation values unchecked), so I
labeled the filings by hand from the filing text and checked that each row's columns add up to its Total. The keys
are in `eval/def14a/*/expected.json`; the filings are downloaded at run time and not committed.

All five filings fit Clairic's window (the largest, SSD, was 60,275 input tokens), so whole-document Clairic ran on
every filing. Money matches to the dollar, text without case, dash style or "&" vs "and".

| Reader                     | Accuracy | Wrong but "found" | Doubtful | Parts read | Input tokens / filing       | Cost / filing | Seconds / filing |
| -------------------------- | -------- | ----------------- | -------- | ---------- | --------------------------- | ------------- | ---------------- |
| 1. Whole document, Clairic | 54.6%    | 11 (5.4%)         | 70.2%    | all        | 37,164                      | $0.0037       | 3.4              |
| 2. Navigated, Jev+Clairic  | 39.0%    | 15 (7.3%)         | 73.2%    | 2.0        | 39,908 (13,013 of them Jev) | $0.0027 ¹     | 2.3              |
| 3. One LLM, structured     | 79.0%    | 34 (16.6%) ²      | 16.1% ²  | all        | 33,601                      | $0.0176 ³     | 8.2              |

¹ Clairic only: pi-ai's catalog lists Jev at $0, and I found no Jev price to use.
² The LLM gives no confidence, so every value it gives counts as found and only its nulls count as doubtful.
³ At an assumed $0.50/M input and $1.50/M output for `mistral-large-latest`; mistral.ai is not reachable from the
sandbox, so the price is not checked. Set `LLM_PRICE_INPUT` and `LLM_PRICE_OUTPUT` to correct it.

Per filing (accuracy):

| Filing | Whole Clairic | Navigated | LLM    | Navigated parts read |
| ------ | ------------- | --------- | ------ | -------------------- |
| BMI    | 78.0%         | 48.8%     | 73.2%  | 2 of 40              |
| MCRI   | 36.6%         | 29.3%     | 100.0% | 2 of 36              |
| NPK    | 51.2%         | 48.8%     | 70.7%  | 4 of 24              |
| SSD    | 58.5%         | 46.3%     | 73.2%  | 1 of 65              |
| WINA   | 48.8%         | 22.0%     | 78.0%  | 1 of 29              |

### Calibration of Clairic's confidence

Over the values that are not null (accuracy in the bucket):

| Bucket    | Whole document    | Navigated         |
| --------- | ----------------- | ----------------- |
| 0.9+      | 50 of 61 (82.0%)  | 40 of 55 (72.7%)  |
| 0.7–0.9   | 23 of 36 (63.9%)  | 8 of 20 (40.0%)   |
| below 0.7 | 39 of 108 (36.1%) | 32 of 126 (25.4%) |

Confidence orders the values well, but 0.9 is not 90% right on these filings.

### Likely causes of the failure

1. **Table text loses its columns.** The HTML converter writes a row's cells in order. Where a filing leaves a cell out
   or spans it (`colspan`, `rowspan`), the values shift. In SSD, rows without a Bonus cell shift left, and Clairic
   read Stock Awards as Bonus and Non-Equity as Stock Awards at 0.92–0.99 confidence; in BMI the header sits one column
   off its values. This hits both Clairic readers and makes most of the wrong-but-found values. The LLM, which read
   the same text, coped better.
2. **Jev stops too early.** It found the Summary Compensation Table first in BMI, MCRI and SSD, but then chose "stop"
   (at 0.37–0.50) with more than 70% of the fields still doubtful, after 1–2 parts. In NPK and WINA the converter did
   not make the table's title a heading, so no choice named the table; Jev read the pay-ratio and pay-versus-performance
   parts instead.
3. **Navigation saves few Clairic tokens with 41 fields.** Clairic repeats the text in each pass and splits 41 field
   schemas over several passes: one 4,668-character part cost 25,399 input tokens, 66% of the whole BMI filing. With
   Jev's ~13,000 tokens of picks on top, the navigated reader used about as many tokens as one whole-document call.
4. **Clairic fills what is not there.** Where a table has no Stock Awards column, it often gives the Option Awards
   value; where there is no 4th or 5th executive, it takes a director or a repeated row instead of null. Most of these
   are below 0.9 and go to review, but not all.
5. **Numbers are predicted, not copied.** Clairic's number answers have no span and sometimes miss a digit (1,840,464
   for 1,740,464). These come with low confidence and go to review.

What would likely help, untested: a converter that expands `colspan`/`rowspan` into a grid and writes each cell with
its column header ("Salary ($): 575,000"); not offering "stop" while most fields are doubtful, or asking Jev a yes/no
question about it; and asking Clairic for one executive's row per call so each pass is small.

### Scoring fix between the two DEF 14A runs

Run 1 scored titles as wrong when they differed only in "-" vs "–" or "&" vs "and". I fixed the text match and ran
the eval again. Run 1 (old scoring): whole-document 52.7%, navigated 36.6%, LLM 82.0%. Run 2 is the table above.
Jev's picks and the LLM's answers vary a little between runs (NPK read 1 part in run 1 and 4 in run 2).

## Cost of the eval

| What                               | Cost                      |
| ---------------------------------- | ------------------------- |
| DEF 14A run 1                      | $0.117                    |
| DEF 14A run 2                      | $0.120                    |
| Live smoke runs (3) and API probes | under $0.001              |
| Jev requests (all runs)            | not priced (see ¹ above)  |
| **Total**                          | **about $0.24**, plus Jev |

## Clairic API findings

Checked on 2026-10-30 against the published schemas
([input](https://developers.cloudflare.com/workers-ai/models/clairic/schema-input.json),
[output](https://developers.cloudflare.com/workers-ai/models/clairic/schema-output.json)) and live calls to
`POST /client/v4/accounts/{account}/ai/run/@cf/cloudflare/clairic`.

| Question                     | Finding                                                                                                                                                                                                                                                                                  | What the code does                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `images` format              | Both forms work and give the same answers: a data URL string, or `{ "content_type", "base64" }`. At most 4 images, 4 MiB each. An answer read from an image has `"source": "image"` and `"span": null`.                                                                                  | Sends data URLs. Drops a null `span`.                                                                                        |
| Usage field names            | `usage.input_tokens` and `usage.output_tokens` (required), plus `state_tokens`, `image_tokens`, `schema_tokens` and `passes`. `output_tokens` is 0.                                                                                                                                      | Reads `input_tokens` and `output_tokens`. Cost is input tokens × $0.10/M, the listed price.                                  |
| REST envelope                | REST wraps the output: `{ "result": {…}, "success": true, "errors": [], "messages": [] }`. A failed call is `{ "success": false, "errors": [{ "message", "code" }], "result": {} }` (seen: HTTP 400, code 3030, for a list field without `items`). `env.AI.run` gives the output itself. | `cloudflareRest` unwraps `result` and throws with the error messages; `clairicDecider` parses the output alone. No guessing. |
| Field names                  | Must match `^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$`.                                                                                                                                                                                                                                           | Keeps an id that matches, since the name tells Clairic what the value is; else names it `q<place>`.                          |
| `model` in the body          | Required: `"clairic"`.                                                                                                                                                                                                                                                                   | Sent.                                                                                                                        |
| Estimates                    | No `confidence` and no `p_null`; they give `mean`, `median`, `p10`, `p90`, `p_below`, `p_above`.                                                                                                                                                                                         | Maps `median`, `p10`, `p90`. An estimate is never "found" in doc-extract, since it has no confidence.                        |
| `confidence` on a null value | A null value can still carry a high `confidence` (0.999 for an absent PO number, with `p_null` 0.9999995): it rates the guess, not the null.                                                                                                                                             | "found" needs a value that is not null, so this never counts as found.                                                       |
| Fields not in the schema     | `spell_confidence` and `source` on text answers read from images.                                                                                                                                                                                                                        | Ignored.                                                                                                                     |
| `truncated`                  | Required in the output.                                                                                                                                                                                                                                                                  | A truncated read fails the request as too long, so the loop sends a smaller view.                                            |

Other finding: in this sandbox Node's `fetch` skips `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`, so the proxy that
holds the keys never saw the first requests and TypeSafe answered 401. It is not a code issue; run the eval with
`NODE_USE_ENV_PROXY=1` behind a proxy.

## How to run it

```bash
cd examples/doc-extract
NODE_USE_ENV_PROXY=1 node --conditions=switch-source eval/live.ts smoke --out out/eval
NODE_USE_ENV_PROXY=1 SEC_USER_AGENT="Name email@domain" node --conditions=switch-source eval/live.ts def14a --out out/eval
```

Keys come from the environment only: `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`MISTRAL_API_KEY`, and `SEC_USER_AGENT` for EDGAR. `def14a` estimates its cost first and stops above $5 without
`--yes`. `prepare` downloads and splits the filings with no model call.
