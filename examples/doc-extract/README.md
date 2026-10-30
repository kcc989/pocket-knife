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

## Run

```bash
pnpm --filter ./examples/doc-extract exec node --conditions=switch-source src/main.ts run cases/invoice --out out/run --extractor cloudflare/clairic
```

It needs `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. `replay` repeats a trace with no
model call.

## Tests and the live eval

The tests run the three cases in `cases/` with stand-in models: a keyword picker for the decision model and a sentence
matcher for the extractor. `eval/` holds the live eval with the real models; see [EVAL.md](EVAL.md).
