# doc-extract eval

## Round 2 (2026-10-30): fixes, a held-out set, and checks

Round 1 (below) failed its DEF 14A pass conditions. Round 2 fixes the causes it found and measures on a **held-out
set**: three new filings (Dorman, Cal-Maine, Weis Markets), labeled before any change and measured with the round-1
code first. Dorman is too large for Clairic's window. Same 41 fields, same "found" rule (confidence ≥ 0.9, p_null ≤ 0.5);
no threshold changed.

### What changed

| Change                                                                                                                                                                                                                        | Why (round-1 cause)                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The HTML converter builds each table as a grid (`colspan`, `rowspan`), finds the header rows, and writes every data cell with its column's name: `Salary ($): 575,000`                                                        | Rows lost their columns, so values shifted                                |
| A short title line just before a table becomes a `## ` heading                                                                                                                                                                | Tables without bold titles had no part of their own                       |
| `strategy: "whole"`: one read of the whole document through the harness                                                                                                                                                       | Lets the one-call reader use the checks below                             |
| `checks`: sum checks in `case.json` (`{ sum, equals, blankIsZero }`). When a row's columns add up to its Total, its values are found, whatever Clairic's confidence. A Total that two rows share is never taken as right      | 70% of fields went to review although many were right                     |
| Navigate: a read takes the picked part and the parts after it up to `readChars`; stop is offered only after a read that found nothing new; `finalRead` reads every part read at once at the end, and only those answers count | Jev stopped after 1–2 parts; confident wrong values piled up across reads |
| `strategy: "select"`: Jev answers one yes/no question per part, Clairic reads the likeliest parts                                                                                                                             | Tried as a cheaper way to navigate                                        |
| `clairicDecider`: `charsPerToken` 4 (measured 4.2 on filings), and `truncated: "keep"` to keep the answers of a text longer than the window                                                                                   | The old 2.3 cut views to a third of what fits                             |
| Scoring: "/" with or without spaces matches                                                                                                                                                                                   | Cal-Maine titles such as "VP/ CFO"                                        |

### Results (8 filings, 328 fields: dev 205, held-out 123)

| Reader                      | Set      | Accuracy  | Found     | Wrong but found | Found right | Input tokens / filing | Cost / filing |
| --------------------------- | -------- | --------- | --------- | --------------- | ----------- | --------------------- | ------------- |
| Whole document, raw Clairic | dev      | 55.6%     | 25.9%     | 4.4%            | 83.0%       | 40,354                | $0.0040       |
| Whole document + checks     | dev      | 54.1%     | 26.3%     | 3.9%            | 85.2%       | 41,296                | $0.0041       |
| Navigated + checks          | dev      | 55.1%     | 31.2%     | 5.9%            | 81.2%       | 155,827               | $0.0136 ¹     |
| One LLM                     | dev      | 81.0%     | 79.0% ²   | 9.8%            | 87.7%       | 37,139                | $0.0194 ³     |
| Whole document, raw Clairic | held-out | 80.5%     | 39.8%     | 0.0%            | 100%        | 52,829                | $0.0053       |
| **Whole document + checks** | held-out | **80.5%** | **58.5%** | **0.0%**        | **100%**    | 53,609                | $0.0054       |
| Navigated + checks          | held-out | 82.1%     | 61.8%     | 0.0%            | 100%        | 212,994               | $0.0183 ¹     |
| One LLM                     | held-out | 75.6%     | 100% ²    | 24.4%           | 75.6%       | 67,378                | $0.0345 ³     |
| Whole document, raw Clairic | all      | 64.9%     | 31.1%     | 2.7%            | 91.2%       | 45,032                | $0.0045       |
| **Whole document + checks** | all      | **64.0%** | **38.4%** | **2.4%**        | **93.7%**   | 45,913                | $0.0046       |
| Navigated + checks          | all      | 65.2%     | 42.7%     | 3.7%            | 91.4%       | 177,265               | $0.0153 ¹     |
| One LLM                     | all      | 79.0%     | 86.9% ²   | 15.2%           | 82.5%       | 48,479                | $0.0251 ³     |

"Found right" is the share of found values that are right: what a reviewer can skip. ¹ Clairic only; Jev is not
priced. ² Every value the LLM gives counts as found. ³ At an assumed Mistral price (see round 1).

Calibration of Clairic's confidence, all 8 filings (right / values with that confidence):

| Bucket    | Raw whole      | Whole + checks | Navigated + checks |
| --------- | -------------- | -------------- | ------------------ |
| 0.9+      | 93/102 (91.2%) | 95/103 (92.2%) | 100/112 (89.3%)    |
| 0.7–0.9   | 52/61 (85.2%)  | 44/56 (78.6%)  | 49/65 (75.4%)      |
| below 0.7 | 68/165 (41.2%) | 71/169 (42.0%) | 65/151 (43.0%)     |

### What the numbers say

- **Recommended reader: the whole document in one Clairic call, with sum checks.** On held-out filings it sent 58.5%
  of fields straight through (raw Clairic: 39.8%) with no wrong value among them, at the same cost. Across all 8
  filings, 93.7% of its found values are right and 0.9+ confidence is 92% right.
- **Navigation does not pay for this task.** With the read window, the stop rule and the final read, navigated
  Clairic matches the whole-document reader's accuracy (65.2% vs 64.0%) but reads most of each filing and costs 3.9×
  the input tokens. On the dev filings its wrong-but-found rate fell from 7.3% (round 1) to 5.9%. All 8 filings but Dorman fit Clairic's
  window, and Dorman's table sits early enough that the cut-off whole read still found it (97.6%). Navigation would
  pay only for documents whose values sit beyond the window.
- **Select-then-read failed.** Jev, asked per part whether it holds a missing value, gave the compensation table
  0.17–0.29 on most filings and rated other tables higher. All 8 filings: 35.7% accuracy (v4 run). It stays in the
  code as a strategy, not recommended for this task.
- **The LLM reads best and is the least safe.** It has the highest accuracy but no confidence, so 15% of fields are
  wrong with nothing to send them to review. On Cal-Maine it scored 2.4% or 26.8% across five runs: it lists the CEO before the board chair, who comes first in the table.
- **Pass conditions of round 1**, with the recommended reader in place of "navigated": wrong but found 2.4% (target
  ≤ 2%, held-out 0%), 0.9+ confidence 92.2% right (target ≥ 90%). The original navigated conditions still fail: it
  uses more tokens than the whole-document reader.

### What still limits accuracy

1. **Malformed source tables.** Simpson's HTML leaves out a Bonus cell in one row and splits a column 2+1 in another;
   a browser would shift those rows too.
2. **Clairic fills absent columns and rows.** It gives the Option Awards value for a missing Stock Awards column, and
   takes directors for a fourth and fifth executive. Most of these go to review.
3. **Ordinal fields are fragile.** "The third executive listed" makes Clairic count rows. A probe that put the
   executives' names in the instructions (from the answer key, so a ceiling) did not raise accuracy overall: it went
   up on Weis (73% → 100% of money fields) and down on others, with more wrong values kept as found.
4. **Checks need every column right.** One wrong addend breaks the sum, so most rows stay doubtful.

### Clairic API findings, round 2

- **Passes depend on the text's length.** A text of about 32,000 characters or more (with 41 fields) is read in
  **one** pass. A shorter text is read in about one pass per four fields, and each pass bills the text again: one
  4,668-character part with 41 fields used 11 passes and 25,399 input tokens; a 16,000-character excerpt of the same
  filing used 1 pass and 9,763 tokens. The single pass was also as accurate or better (BMI excerpt: 56% vs 46%). This
  is the reverse of what the docs say ("fields that do not fit next to the state in one 8,192-token pass are split
  across parallel passes").
- **Tokens:** Clairic counted 4.2 characters per token on filing text (34,225 state tokens for 144,678 characters),
  against 2.3 on a short invoice line.
- **Truncation:** a 475,000-character filing was cut at 65,529 input tokens with `truncated: true`, and the answers
  from its start were still good.

### Cost

Round 2 spent about $1.85: the held-out baseline $0.11, runs v2–v7 $1.69, and probes about $0.05. With round 1, the
eval has cost about $2.10, plus Jev requests, which are not priced.

---

## Round 1

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
