# Decision model API

## TL;DR

A decision model reads some content once and answers typed questions about it with probabilities. It writes no text.
TypeSafe defined the API for its Jev model, `POST /v1/systemone`, and llama.cpp and Cloudflare Workers AI serve open
decision models with the same data model: a request holds a `state` and named `questions`, and a response holds one
typed answer per question, with the probability of every answer that the question allows. The providers differ in a
few fields and limits. Only TypeSafe has `box` questions and takes images as `assets`; llama.cpp and Clef take an
`images` list instead and need `instructions` on every question.

## What a decision model is

A chat model writes text one token at a time, and a program has to parse that text to get a decision. A decision
model skips the text. It reads the input in one forward pass and gives a probability to each answer that the caller
allows. TypeSafe, which made the first one, Jev, calls them System One models, after Kahneman's fast and intuitive
"System 1" thinking. Its docs say that they "do not write replies, produce code, or generate explanations of their
reasoning."

This makes them fast and cheap. Output tokens cost nothing: llama.cpp reports none, and TypeSafe and Cloudflare do not
charge for them. On llama.cpp, the small models answer a question in a few milliseconds. It also makes them safe to
wire into a program: the answer of a choice question is always one of the options that the caller gave.

## Data model

The types below are the whole API, written in TypeScript. They join the schemas of the three providers into one, and
a comment marks each field that only some providers have.
[Differences between providers](#differences-between-providers) lists the rest.

Most fields that the model reads take the same three forms, which this doc calls `Content`:

```ts
/** Something for the model to read: a string, or a JSON object or array, which the model reads as JSON text. */
type Content = string | { [key: string]: unknown } | unknown[];
```

### Request

A request is one JSON object:

```ts
interface Request {
  /** The model, by name or alias. TypeSafe and Clef need it. llama.cpp uses it when the server has several models. */
  model?: string;
  /** What every question of the request is about. */
  state: Content;
  /** The questions, by an id that the caller picks. The answers come back under the same ids. At least one. */
  questions: { [id: string]: Question };
  /** Images, on llama.cpp and Clef. */
  images?: Image[];
  /** Images, on TypeSafe. */
  assets?: { [placeholder: string]: Asset };
}
```

The `state` holds everything that the questions need, such as a customer's message with their transactions and the
refund policy. All the questions of a request share it.

### Questions

There are four types of question. Every provider has the first three, and only TypeSafe has `box`:

```ts
type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion | BoxQuestion;

/** Is this true? */
interface NoulQuestion {
  type: "noul";
  /** The question or statement. TypeSafe: optional. llama.cpp and Clef: required. The same holds for every type. */
  instructions?: Content | null;
  /** What counts as true and what counts as false. */
  criteria?: { true?: Content | null; false?: Content | null } | null;
}

/** Which of these options fits? */
interface ChoiceQuestion {
  type: "choice";
  instructions?: Content | null;
  /** Each option's name and its description. With a null description, the model reads the name alone. */
  criteria: { [option: string]: Content | null };
}

/** Where on this scale is it? */
interface ScoreQuestion {
  type: "score";
  instructions?: Content | null;
  /** The levels' descriptions, lowest first. Level i is the one at index i. */
  criteria: Content[];
}

/** Where in the image is it? TypeSafe only. */
interface BoxQuestion {
  type: "box";
  /** What to find in the image. */
  instructions?: Content | null;
}
```

Instructions and descriptions can be JSON as well as text. Clef's schema gives the reason: an object can hold the
question in one field and the data it refers to in others.

### Images

The providers take images in three ways. llama.cpp and Clef take an `images` list, which the OpenJev multimodal API
added to TypeSafe's API, and put the images before the state in the prompt:

```ts
/** llama.cpp: a data URL, such as "data:image/png;base64,…". Clef: a data URL, or the bytes with their type. */
type Image = string | { content_type: string; base64: string };
```

llama.cpp also takes a `state` that is a list of chat messages, or an object with a `messages` list. An `image_url`
part in a message's content is read as an image, as in chat completions, and is taken out of the text.

TypeSafe takes `assets` instead. Each asset has a placeholder, such as an id, and the image goes wherever the
placeholder appears in a string of the state, the instructions or the criteria:

```ts
/** TypeSafe: an image in base64 with its format, or, in a multipart request, the name of the part that holds it. */
interface Asset {
  type: "image";
  /** Needed with data_base64. The server reads the real format from the bytes. */
  format?: "png" | "jpg" | "jpeg";
  data_base64?: string;
  /** With part, data_base64 is ignored. */
  part?: string;
}
```

Requests with assets or box questions need the header `TypeSafe-Danger-Zone-Images: true`. TypeSafe's docs also say
that Jev itself reads text only, so images need one of its image models.

### Response

A response has one answer for each question, of the question's type:

```ts
interface Response {
  /** The model that answered. It can differ from the alias in the request. */
  model: string;
  /** One answer per question, under the question's id. */
  answers: { [id: string]: Answer };
  usage: { input_tokens: number; output_tokens: number };
}

type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer | BoxAnswer;

interface NoulAnswer {
  type: "noul";
  /** The probability of true, from 0 to 1. */
  noul: number;
}

interface ChoiceAnswer {
  type: "choice";
  /** The option with the highest probability. */
  choice: string;
  /** Each option's probability. They sum to 1. */
  probabilities: { [option: string]: number };
  /** From 0 to 1. See Confidence. */
  confidence: number;
}

interface ScoreAnswer {
  type: "score";
  /** The expected level. It can fall between two levels. */
  score: number;
  /** Each level's index, as a string, and its description. */
  legend: { [level: string]: Content };
  /** Each level's probability, under the same keys as legend. They sum to 1. */
  probabilities: { [level: string]: number };
  confidence: number;
}

/** TypeSafe only. */
interface BoxAnswer {
  type: "box";
  /** The box's edges as fractions of the image: top and bottom from its top edge, left and right from its left edge. */
  box: { top: number; bottom: number; left: number; right: number };
  /** Null when the model gives no confidence. */
  confidence: number | null;
}
```

Each question is answered on its own: one answer does not depend on another. Clef is the exception, as it reads all
the questions in one prompt and decides them together. Some models read the state only once for all the questions,
which makes extra questions cheap.

## Differences between providers

These are from the providers' schemas and docs in October 2026:

| Field or limit         | TypeSafe                               | llama.cpp                                                          | Clef on Workers AI                                      |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `model`                | Required                               | Optional; picks a model on a server with several                   | Required: `clef` or `clef-flash`                        |
| `instructions`         | Optional                               | Required                                                           | Required, and not empty                                 |
| Question types         | `noul`, `choice`, `score`, `box`       | `noul`, `choice`, `score`                                          | `noul`, `choice`, `score`                               |
| Questions in a request | 1 or more                              | 1 or more                                                          | 1 to 64                                                 |
| Question ids           | Any string                             | Any string                                                         | Letters, digits, `_`, `.` and `-`, up to 100 characters |
| Options of a `choice`  | 1 to 255                               | 1 to the model's limit: 52 for OpenJev, 255 for Kev, Laya and Clef | 2 to 255                                                |
| Levels of a `score`    | 1 to 10                                | 2 to 10                                                            | 2 to 10                                                 |
| Images                 | `assets`: PNG or JPEG, with the header | `images`: up to 8 data URLs; or chat messages                      | `images`: up to 4, PNG, JPEG or WebP, 4 MiB each        |
| Context                | Long context needs a header            | The server's settings                                              | 65,536 tokens; long text in the state is cut            |

On llama.cpp, Laya and Clef must also fit the whole prompt into one batch of the server's `--ubatch-size`.

## An example

This request works on TypeSafe and on a llama.cpp server with one model:

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

This is the response from OpenJev on llama.cpp:

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

The choice options here have no descriptions. Descriptions help: in the llama.cpp blog, a small model sent "charged
twice" to shipping with bare option names, and picked billing at 0.99 once each team had a description.

## Reading the answers

A `noul` answer near 1 means yes, near 0 means no, and near 0.5 means that the model is unsure.

A `score` answer's `score` is the probability-weighted mean of the levels. For levels $0, \dots, n-1$ with
probabilities $p_i$:

$$\text{score} = \sum_{i=0}^{n-1} i \, p_i$$

In the example, $0 \cdot 0.0023 + 1 \cdot 0.116 + 2 \cdot 0.6753 + 3 \cdot 0.2064 \approx 2.09$: mostly "today",
leaning toward "right now". The `probabilities` show the whole spread, which the mean hides.

## Confidence

Choice and score answers carry a `confidence` from 0 to 1. It says how far the probabilities are from an even spread,
so a caller can act on confident answers and send the rest to a person. llama.cpp computes it with the formulas that
TypeSafe published.

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
its number of options. A model may also prefer the first label it sees. One of the open models, lev, therefore reads a
choice's options in two orders and averages the two results.

TypeSafe trains Jev "for calibrated decisions", and its docs add that "calibration is measured across groups of
predictions; it does not guarantee that an individual answer is correct". llama.cpp says the same of the open models:
the probabilities "are not guaranteed to be calibrated for your data". The same answer can also get different
probabilities from different models: in the llama.cpp blog, one vague ticket scored 0.25 on one model and 0.80 on
another. A cutoff such as "act above 0.9" has to be tested on the caller's own examples, for each model.

## Providers

**TypeSafe** serves Jev at `POST https://api.typesafe.ai/v1/systemone`.

- **Authentication:** the API key goes in the header `Authorization: Bearer <API_KEY>`.
- **Headers:** `TypeSafe-Danger-Zone-Images: true` turns on assets and box questions, and
  `TypeSafe-Danger-Zone-Long-Context: true` turns on long context.
- **Multipart:** a request can also be `multipart/form-data`, with the JSON as the first part, named `request`, and
  each image as a part of its own. Each image part is named by the `part` of exactly one asset.
- **Models:** `GET /v1/models` returns `{ "models": [{ "name", "description", "release_date" }] }`. `jev-latest` is
  the default of TypeSafe's client libraries.
- **Errors:** `400` with `{ "detail": string | object }` for a bad request, and `422` with
  `{ "detail": [{ "loc", "msg", "type", "input"?, "ctx"? }] }` for a body that does not match the schema.
- **Cost:** input tokens are billed, and output tokens are free.

**llama.cpp** serves open decision models at `POST /v1/systemone` on `llama serve`, so a client of TypeSafe's API only
needs a new base URL. It does not stream. Errors come as `{ "error": { "code", "message", "type" } }`: `400` for a bad
request, and `501` for a model that is not a decision model, or for images that the model or the server cannot read.
`GET /v1/models` marks a decision model with the output modality `decisions`. The models in llama.cpp's blog post are
these:

| Model   | Size | Base             | Languages              | Images | License      | Time per question |
| ------- | ---- | ---------------- | ---------------------- | ------ | ------------ | ----------------- |
| Julia-1 | 144M | mmBERT-small     | 50+                    | No     | Apache 2.0   | 3 ms              |
| Laya    | 421M | ModernBERT-large | English                | No     | Apache 2.0   | 5 ms              |
| Kev-4B  | 4B   | Qwen3.5-4B-Base  | English                | No     | Apache 2.0   | 12 ms             |
| lev     | 4B   | Qwen3.5-4B       | English                | No     | Apache 2.0   | 36 ms             |
| OpenJev | 27B  | Qwen3.8-27B      | en, de, fr, hi, zh, ja | Yes    | CC BY-NC 4.0 | 43 ms             |
| Clef    | 27B  | Qwen3.8-27B      | English                | Yes    | Apache 2.0   | Not given         |

The times are medians per question on one NVIDIA RTX PRO 6000.

**Cloudflare Workers AI** serves Clef as `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`, at
`POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef`, or from a Worker with
`env.AI.run`. The REST API wraps the response in Cloudflare's usual `{ success, result }` envelope. Clef costs $0.24
per million input tokens, images included, and output tokens are free. On Clef, an image costs one token per 32 × 32
pixel block plus 3, at most 1,024 tokens.

## Sources

- TypeSafe: [System One models](https://docs.typesafe.ai/concepts/system-one), the
  [API reference](https://docs.typesafe.ai/api) and its [OpenAPI spec](https://api.typesafe.ai/openapi.json).
- llama.cpp: the server README, section "POST `/v1/systemone`: TypeSafe-compatible System One API", the server's
  decision code in `tools/server/server-decision.cpp`, and the blog post
  [New in llama.cpp: Decision Models](https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp).
- OpenJev: the [multimodal API](https://jev-skills.github.io/openjev-multimodal/api).
- Cloudflare: the [Clef model page](https://developers.cloudflare.com/workers-ai/models/clef/), with its
  [input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json) and
  [output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json).
