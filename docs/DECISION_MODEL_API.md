# Decision model API

## TL;DR

A decision model reads some content once and answers typed questions about it with probabilities. It writes no text.
TypeSafe defined the API for its Jev model, `POST /v1/systemone`, and llama.cpp and Cloudflare Workers AI serve open
decision models through the same request shape: a `state`, a set of named `questions`, and optional images. Each
answer is a probability over the answers that the question allows, so the answer is always one of them. The
providers differ mainly in how they take images and in their limits, such as at most 52 options per question for
OpenJev and at most 4 images per request for Clef.

## What a decision model is

A chat model writes text one token at a time, and a program has to parse that text to get a decision. A decision
model skips the text. It reads the input in one forward pass and gives a probability to each answer that the caller
allows. TypeSafe, which made the first one, Jev, calls them System One models, after Kahneman's fast and intuitive
"System 1" thinking. Its docs say that they "do not write replies, produce code, or generate explanations of their
reasoning."

This makes them fast and cheap. Output tokens cost nothing: llama.cpp reports none, and TypeSafe and Cloudflare do not
charge for them. On llama.cpp, the small models answer a question in a few milliseconds. It also makes them safe to
wire into a program: the answer of a choice question is
always one of the options that the caller gave.

## The request

A request is one JSON object. The same body works on TypeSafe's API and on a llama.cpp server with one model:

```json
{
  "model": "jev-latest",
  "state": "Customer message: I was charged twice for my order last week and nobody has replied.",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "billing": null, "shipping": null, "technical": null }
    },
    "angry": { "type": "noul", "instructions": "Is the customer angry?" },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this?",
      "criteria": ["can wait", "this week", "today", "right now"]
    }
  }
}
```

It has these fields:

- **`state`** is the content that every question in the request is about: a string, a JSON object or an array. A
  value that is not a string reaches the model as JSON text. The state can hold anything the decision needs, such as
  a customer's message with their transactions and the refund policy.
- **`questions`** maps a question id to a question. Every question has a `type` and `instructions`, the question
  itself. Most types also have `criteria`, the answers that the question allows.
- **`model`** names the model. TypeSafe needs it. A llama.cpp server with one model ignores it, and one that serves
  several models picks by it.
- **Images** are optional, and each provider takes them in its own way. See [Images](#images).

## Question types

Three types work on every provider:

| Type     | What it asks                 | `criteria`                                           |
| -------- | ---------------------------- | ---------------------------------------------------- |
| `choice` | Which of these options fits? | An object from each option's name to its description |
| `score`  | Where on this scale is it?   | An array of level descriptions, lowest level first   |
| `noul`   | Is this true?                | Optional: descriptions of `true` and `false`         |

A choice option's description can be `null`, and then the model reads the option's name alone. The llama.cpp blog
shows why descriptions help: with bare labels, a small model sent "charged twice" to shipping, and with a description
of each team, it picked billing at 0.99.

TypeSafe also has a fourth type, `box`, which finds a region in an image and returns its four edges as fractions of
the image's size. It needs an image model and an opt-in header, and llama.cpp does not serve it.

The questions of one request share the state, and each one is answered on its own: one answer does not depend on
another. Clef is the exception, as it reads all the questions in one prompt and decides them together. Some models
read the state only once for all the questions of a request, which makes extra questions cheap.

## The answer

The response maps each question id to its answer, and adds the model's name and the token usage:

```json
{
  "model": "openjev",
  "answers": {
    "route": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.9998, "shipping": 0.0001, "technical": 0.0001 },
      "confidence": 0.9997
    },
    "angry": { "type": "noul", "noul": 0.6328 },
    "urgency": {
      "type": "score",
      "score": 2.0858,
      "legend": { "0": "can wait", "1": "this week", "2": "today", "3": "right now" },
      "probabilities": { "0": 0.0023, "1": 0.116, "2": 0.6753, "3": 0.2064 },
      "confidence": 0.673
    }
  },
  "usage": { "input_tokens": 239, "output_tokens": 0 }
}
```

Each type answers in its own form:

- A **`choice`** answer gives the probability of every option, which sum to 1, and names the likeliest one as
  `choice`.
- A **`noul`** answer is one number, the probability that the statement is true. Near 1 means yes, near 0 means no,
  and near 0.5 means that the model is unsure.
- A **`score`** answer gives the probability of every level, by the level's index from 0, and a `legend` from each
  index to its description. Its `score` is the expected level, so it can fall between two levels.

For a score question with levels $0, \dots, n-1$ and probabilities $p_i$, the score is the probability-weighted mean
of the levels:

$$\text{score} = \sum_{i=0}^{n-1} i \, p_i$$

In the example above, $0 \cdot 0.0023 + 1 \cdot 0.116 + 2 \cdot 0.6753 + 3 \cdot 0.2064 \approx 2.09$: mostly "today",
leaning toward "right now".

## Confidence

Choice and score answers also carry a `confidence` from 0 to 1. It says how far the probabilities are from an even
spread, so a caller can act on confident answers and send the rest to a person. llama.cpp computes it with the
formulas that TypeSafe published.

For a choice among $n$ options, it measures how far the likeliest option's probability $p_{\max}$ rises above the even
share $1/n$, as a fraction of the most it could rise:

$$c = \max\left(0, \frac{p_{\max} - 1/n}{1 - 1/n}\right)$$

So an even spread gives 0, and one option at probability 1 gives 1.

For a score with levels $0, \dots, n-1$, the order of the levels matters, so the formula looks at distance instead.
Let $m$ be the likeliest level. The confidence compares the expected distance from $m$ with the expected distance of
an even spread from the middle of the scale:

$$c = \max\left(0, 1 - \frac{\sum_i p_i \, |i - m|}{\sum_i \frac{1}{n} \left|i - \frac{n-1}{2}\right|}\right)$$

Probabilities piled on one level give 1. Probabilities spread over far-apart levels give a low value, even when one
level is the likeliest.

## How a model gets its probabilities

The providers' docs do not say how a model scores its options, but llama.cpp's server code shows two ways for the
open models:

- **Labels.** The prompt gives each option a short label, such as A, B and C, and the model's probabilities for the
  next token are read at those labels. Each label must be one token, so the number of labels limits the number of
  options: OpenJev uses A to Z and a to z, which gives 52.
- **A reading per option.** The model reads each option, and the server reads the model's hidden state at the token
  that ends the option, for Kev, or at a mask token, for Laya, and turns it into a score. These models take up to 255
  options.

Either way, the model gives each option a raw score $s_i$, and a softmax with a temperature $T$ turns the scores into
probabilities:

$$p_i = \frac{e^{s_i / T}}{\sum_j e^{s_j / T}}$$

The temperature is stored in the model file. The model's makers fit it, and it can depend on the question's type and
its number of options. A model may also prefer
the first label it sees. One of the open models, lev, therefore reads a choice's options in two orders and averages
the two results.

TypeSafe trains Jev "for calibrated decisions", and its docs add that "calibration is measured across groups of
predictions; it does not guarantee that an individual answer is correct". llama.cpp says the same of the open models:
the probabilities "are not guaranteed to be calibrated for your data". The same answer can also get different
probabilities from different models: in the llama.cpp blog, one vague ticket scored 0.25 on one model and 0.80 on
another. A cutoff such as "act above 0.9" has to be tested on the caller's own examples, for each model.

## Images

Image models read images together with the state. The providers take them in three ways:

- **An `images` list.** llama.cpp and Clef take an array of data URLs, such as `data:image/png;base64,…`. The images
  go before the state in the prompt. This list is an extension that the OpenJev multimodal API defined.
- **Chat messages.** llama.cpp also takes a `state` that is a list of chat messages, or an object with a `messages`
  list. An `image_url` part in a message is read as an image, as in chat completions, and is taken out of the text.
- **Assets.** TypeSafe takes an `assets` object that maps a placeholder, such as an id, to an image. The placeholder
  can then appear anywhere in the state, the instructions or the criteria, and the image goes in its place. Images on
  TypeSafe need an image model and the header `TypeSafe-Danger-Zone-Images: true`. Its docs say that Jev itself reads
  text only.

Images count as input tokens. On Clef, an image costs one token per 32 × 32 pixel block plus 3, at most 1,024 tokens.

## Limits

Each provider and model has its own limits. These are from their docs in October 2026:

| Limit                         | TypeSafe API                | llama.cpp                               | Clef on Workers AI       |
| ----------------------------- | --------------------------- | --------------------------------------- | ------------------------ |
| Options per `choice` question | 1 to 255                    | Per model: 52 for OpenJev, 255 for Laya | Not stated               |
| Levels per `score` question   | 1 to 10                     | 2 to 10                                 | Not stated               |
| Questions per request         | At least 1                  | At least 1                              | 1 to 64                  |
| Images per request            | Not stated                  | 8                                       | 4, of at most 4 MiB each |
| Context                       | Long context needs a header | The server's settings, see below        | 65,536 tokens            |

On llama.cpp, Laya and Clef must fit the whole prompt into one batch of the server's `--ubatch-size`. Clef cuts long
text in the state to fit its window. A request that does not fit fails with an error.

## Providers

**TypeSafe** serves Jev at `POST https://api.typesafe.ai/v1/systemone`, with the API key as a bearer token.
`GET /v1/models` lists the model names, and `jev-latest` is the default of TypeSafe's client libraries. Errors are
`400` for a bad request and `422`
for a body that does not match the schema. Output tokens are free.

**llama.cpp** serves open decision models at `POST /v1/systemone` on `llama serve`, so a client of TypeSafe's API only
needs a new base URL. Errors are `400` for a bad request and `501` for a model that is not a decision model, or for
images that the model cannot read. The models in its blog post are these:

| Model   | Size | Base             | Languages              | Images | License      | Time per question |
| ------- | ---- | ---------------- | ---------------------- | ------ | ------------ | ----------------- |
| Julia-1 | 144M | mmBERT-small     | 50+                    | No     | Apache 2.0   | 3 ms              |
| Laya    | 421M | ModernBERT-large | English                | No     | Apache 2.0   | 5 ms              |
| Kev-4B  | 4B   | Qwen3.5-4B-Base  | English                | No     | Apache 2.0   | 12 ms             |
| lev     | 4B   | Qwen3.5-4B       | English                | No     | Apache 2.0   | 36 ms             |
| OpenJev | 27B  | Qwen3.8-27B      | en, de, fr, hi, zh, ja | Yes    | CC BY-NC 4.0 | 43 ms             |
| Clef    | 27B  | Qwen3.8-27B      | English                | Yes    | Apache 2.0   | Not given         |

The times are medians per question on one NVIDIA RTX PRO 6000.

**Cloudflare Workers AI** serves Clef as `@cf/cloudflare/clef`, and also `@cf/cloudflare/clef-flash`, at
`POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef`, or from a Worker with
`env.AI.run`. The body has the same `state`, `questions` and `images`, with `model` set to `clef` or `clef-flash`, and
the REST API wraps the answer in Cloudflare's usual `{ success, result }` envelope. Clef costs $0.24 per million
input tokens, and output tokens are
free.

## Sources

- TypeSafe: [System One models](https://docs.typesafe.ai/concepts/system-one) and the
  [API reference](https://docs.typesafe.ai/api), with its [OpenAPI spec](https://api.typesafe.ai/openapi.json).
- llama.cpp: the server README, section "POST `/v1/systemone`: TypeSafe-compatible System One API", the server's
  decision code in `tools/server/server-decision.cpp`, and the blog post
  [New in llama.cpp: Decision Models](https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp).
- OpenJev: the [multimodal API](https://jev-skills.github.io/openjev-multimodal/api).
- Cloudflare: the [Clef model page](https://developers.cloudflare.com/workers-ai/models/clef/).
