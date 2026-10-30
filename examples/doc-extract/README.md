# doc-extract

An example harness on switch with two models. A decision model, such as TypeSafe's Jev, picks which `## ` part of a
document to read next, or stops. An extractor, Cloudflare's Clairic, reads only that part and answers value questions
for the fields that are still missing.

A value is **found** when it is not null or an empty list, its probability of null is at most 0.5 and its confidence
at least 0.9. Every other field is **doubtful**, for a person to review.

## A case

A case folder holds `case.json`, the document and, for evals, `expected.json`:

```json
{
  "id": "receipt",
  "document": "document.md",
  "fields": {
    "total_paid": { "kind": "number", "instructions": "The total amount paid", "field": { "decimals": 2 } }
  }
}
```

`kind` is one of Clairic's types (text, number, date, time, datetime, duration, list, estimate, forecast), and `field`
holds Clairic's own settings for the field, such as `unit`, `items`, `min` and `max`. `expected.json` is
`{ "values": { "total_paid": 31.48 } }`.

## Case settings

| Setting       | Default      | What it does                                                                                                                                                                                                                                |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategy`    | `"navigate"` | `"navigate"`: Jev picks one part at a time, or stops. `"whole"`: one read of the whole document. `"select"`: Jev answers per part whether it holds a missing value, then one read of the likeliest parts.                                   |
| `readChars`   | `0`          | Navigate: a read takes the picked part and the unread parts after it until it holds this many characters. Clairic reads a text of about 32,000 characters or more in one pass, and a shorter one in several passes that each bill the text. |
| `finalRead`   | `false`      | Navigate: after the model stops, read every part read at once; only those answers count.                                                                                                                                                    |
| `selectChars` | `60000`      | Select: the most characters to read.                                                                                                                                                                                                        |
| `checks`      | `[]`         | Sum checks, `{ "sum": [...], "equals": "total", "blankIsZero": true }`: values that add up are found, whatever the extractor's confidence. A total that two checks share is never taken as right.                                           |

Stopping is offered only after a read that found nothing new. On the DEF 14A eval, `"whole"` with sum checks was the
best reader for documents that fit Clairic's window; see [EVAL.md](EVAL.md).

## Run

```bash
pnpm --filter ./examples/doc-extract exec node --conditions=switch-source src/main.ts run cases/invoice --out out/run --extractor cloudflare/clairic
```

It needs `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. `replay` repeats a trace with no
model call.

## Tests and the live eval

The tests run the three cases in `cases/` with stand-in models: a keyword picker for the decision model and a sentence
matcher for the extractor. `eval/` holds the live eval with the real models; see [EVAL.md](EVAL.md).
