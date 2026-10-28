# Decision model APIs

## TL;DR

A decision model reads some content once and answers typed questions about it with probabilities. It writes no text.
There are three ways to call one: TypeSafe's System One API, which TypeSafe, llama.cpp and Cloudflare serve; OpenAI's
Decisions API, for GPT-6 Luna; and a chat model used as a classifier through its next-token probabilities. The
library pi-ai puts one interface over all three. That interface can say less than System One, as it has no string
state and no score probabilities, but a request written in it runs on every one of them.

## What a decision model is

A chat model writes text one token at a time, and a program has to parse that text to get a decision. A decision
model skips the text. It reads the input in one forward pass and gives a probability to each answer that the caller
allows. TypeSafe, which made the first one, Jev, calls them System One models, after Kahneman's fast and intuitive
"System 1" thinking. Its docs say that they "do not write replies, produce code, or generate explanations of their
reasoning."

This makes them fast and cheap. Output tokens cost nothing: llama.cpp reports none, and TypeSafe, Cloudflare and
OpenAI do not charge for them. On llama.cpp, the small models answer a question in a few milliseconds. It also makes
them safe to wire into a program: the answer of a choice question is always one of the options that the caller gave.

## The APIs

All of them take some content and a set of typed questions, and return a probability for every answer that each
question allows. They differ in their names, their shapes and what else they can do:

| API                                                       | Endpoint                           | Who serves it                                                       | Yes-or-no type    | Extra types |
| --------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- | ----------------- | ----------- |
| [System One](#system-one-api)                             | `POST /v1/systemone`               | TypeSafe, llama.cpp, Cloudflare Workers AI, and resellers of Jev    | `noul`            | `box`       |
| [OpenAI Decisions](#openai-decisions-api)                 | `POST /v1/decisions`               | OpenAI, for GPT-6 Luna                                              | `predicate`       | None        |
| [Chat models as classifiers](#chat-models-as-classifiers) | A chat model's completion endpoint | Any server that returns next-token probabilities, such as llama.cpp | Yes and No labels | None        |

Each API also has `choice` and `score` questions. [pi-ai](#pi-ais-classifier-interface), a TypeScript library, calls
all three through one interface, so a program can move between them without changing its requests.

## System One API

TypeSafe defined this API for Jev. llama.cpp serves open decision models with it, and Cloudflare Workers AI serves
Clef with it, with a few differences.

### Data model

The types below are the whole API, written in TypeScript. They join the schemas of TypeSafe, llama.cpp and Clef into
one, and a comment marks each field that only some of them have.
[Differences between providers](#differences-between-providers) lists the rest.

Most fields that the model reads take the same three forms, which this doc calls `Content`:

```ts
/** Something for the model to read: a string, or a JSON object or array, which the model reads as JSON text. */
type Content = string | { [key: string]: unknown } | unknown[];
```

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

### Differences between providers

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

### An example

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

### Providers

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
pixel block plus 3, at most 1,024 tokens. Workers AI also serves Jev, which takes images as `assets` there.

**Resellers.** OpenRouter, Vercel AI Gateway and OpenCode also serve Jev with this API, and OpenRouter also serves
Clef, according to pi-ai's docs. OpenRouter takes images as `image_url` parts placed before the state, and drops
`assets` without an error.

## OpenAI Decisions API

OpenAI serves GPT-6 Luna at `POST /v1/decisions`. The idea is the same as System One, but the shapes differ: the
questions are a list with names instead of a map, the options and levels are lists of objects, and the yes-or-no type
is `predicate`, which has no criteria.

### Data model

```ts
interface DecisionsRequest {
  /** "gpt-6-luna", the only model. */
  model: string;
  /** What every question is about: a string, or a list of messages, tool calls and tool outputs. */
  input: string | InputItem[];
  /** 1 to 400 questions. */
  questions: DecisionsQuestion[];
  /** Optional: partitions cache reuse by this key. */
  prompt_cache_key?: string;
  /** Optional: "explicit" caches only up to the breakpoints that the input marks. */
  prompt_cache_options?: { mode: "explicit" };
}

/** Text or images, with no message around them. */
type Instructions = string | ({ type: "input_text"; text: string } | { type: "input_image"; image_url: string })[];

type DecisionsQuestion =
  /** Is this true? The meanings of true and false go into the instructions. */
  | { type: "predicate"; name: string; instructions: Instructions }
  /** Which of these options fits? */
  | { type: "choice"; name: string; instructions: Instructions; choices: { value: string; description?: string }[] }
  /** Where on this scale is it? 2 to 10 levels, lowest first. */
  | { type: "score"; name: string; instructions: Instructions; levels: { label: string; description?: string }[] };

interface DecisionsResponse {
  answers: DecisionsAnswer[];
  /** Cached and cache-write tokens are part of input_tokens. */
  usage: { input_tokens: number; input_tokens_details: { cached_tokens: number; cache_write_tokens: number } };
}

type DecisionsAnswer =
  | { type: "predicate"; name: string; probability: number }
  | {
      type: "choice";
      name: string;
      choice: string;
      probabilities: { value: string; probability: number }[];
      confidence: number;
    }
  | {
      type: "score";
      name: string;
      score: number;
      probabilities: { value: number; label: string; probability: number }[];
      confidence: number;
    }
  /** The model would not answer this question. */
  | { type: "refusal"; name: string };
```

Each answer carries its question's `name`. A choice's `probabilities` and a score's `probabilities` are lists, and a
score's list gives each level's index and label, like System One's `legend`.

### Input

The `input` is a string, or a list of items as in OpenAI's Responses API:

- **User messages** take text, images and JSON. JSON goes in an `input_json` part, with the object or array in `data`.
  Fields such as `role` inside `data` are only data.
- **Developer and system messages** take text only, and a system message counts as a developer message.
- **Assistant messages** take output text or refusals.
- **Tool outputs** take text and images, and name their call with `call_id`.
- **Images** are `input_image` parts with a data URL or a public URL. Files, audio and file ids are not supported.

### Costs and caching

Input costs $0.10 per million uncached tokens, and output tokens are free. The input is cached at its end by default,
when it has at least 1,024 tokens. Questions are never cached. Cache reads cost less than uncached input, so later
requests over the same long input cost less than the first. OpenAI says the API is about ten times as fast as its
Responses API.

## Chat models as classifiers

A chat model that is not a decision model can still answer typed questions, if its server returns the probabilities
of the next token. The program writes each question as a prompt that ends with the allowed answers under one-token
labels, asks for one token, and reads the probabilities of the labels.

pi-ai does this with llama.cpp's server, which it calls the `llama-cpp-classify` API:

1. Each question becomes one chat prompt: the state, every question of the request, the state again, and then the
   question with its answers under labels. A choice uses letters and digits, up to 62 options. A score uses the digits
   0 to 9, up to 10 levels. A yes-or-no question uses `Yes` and `No`.
2. The server's `/tokenize` gives each label's token, and `/apply-template` applies the model's own chat template, with
   thinking turned off.
3. `/completion` with `n_predict: 1` and `n_probs` returns the log-probabilities of the likeliest next tokens. They are
   taken before sampling, so the server's sampling settings do not change them.
4. A softmax over the labels' log-probabilities gives the answer's probabilities. A label that is missing from the
   list is asked for again with a longer list.

The prompt up to the final question is the same for every question of a request, so the server's prompt cache reads
the state once. The result has no token usage.

## pi-ai's classifier interface

pi-ai is a TypeScript library that calls many model providers through one interface. Its `classify` function takes
one request form, sends it to the model's API, and turns the answer back into one result form.

### Data model

```ts
interface ClassifierContext {
  /** What every question is about: a JSON object only. */
  state: { [key: string]: unknown };
  /** Images, for models that read images. */
  images?: { type: "image"; data: string; mimeType: string }[];
  /** The questions, by id. */
  questions: { [id: string]: ClassifierQuestion };
}

type ClassifierQuestion =
  | { type: "choice"; instructions: string; criteria: { [option: string]: string } }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };

interface ClassifierResult {
  /** The API, the provider and the model that answered. */
  api: string;
  provider: string;
  model: string;
  /** One answer per question, under the question's id. Empty when stopReason is not "stop". */
  answers: { [id: string]: ClassifierAnswer };
  /** Token counts and their cost at the model's catalog price, when the API reports token counts. */
  usage?: Usage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: { [option: string]: number }; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };
```

`classify` never throws for an error of the provider, the key or the answer. It returns a result with
`stopReason: "error"` and the message instead. Its options include an API key, a timeout, retries and a `temperature`
that divides the answer logits, which only the chat-model API can apply.

### How it maps to each API

| pi-ai             | System One                                                                 | OpenAI Decisions                                                           | Chat models                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| `state`           | `state`, as it is                                                          | `input`, as JSON text                                                      | The prompt, as JSON text      |
| `bool`            | `noul`                                                                     | `predicate`, with the meanings of true and false added to the instructions | `Yes` and `No` labels         |
| `choice` criteria | `criteria`                                                                 | `choices`, as `{ value, description }`                                     | Letter and digit labels       |
| `score` criteria  | `criteria`                                                                 | `levels`, as `{ label }`                                                   | Digit labels                  |
| `images`          | `assets`, an `images` list or `image_url` parts, depending on the provider | One user message with the state and the images, at most 128                | Through the chat template     |
| `bool` answer     | from `noul`                                                                | from `probability`                                                         | The `Yes` label's probability |
| Refusal           | None                                                                       | The whole result is an error                                               | None                          |

### What it leaves out

pi-ai's form keeps only what all three APIs can do, so a request in it runs on any of them. Its own docs say: "The
public contract uses `bool` questions and `{ type: "bool", probability }` answers. The TypeSafe adapter translates
those to and from its `noul` wire representation." These are what it leaves out:

- **From the request:** a string or array state, JSON instructions and descriptions, `null` descriptions, System
  One's `box` questions, and OpenAI's message input and prompt caching.
- **From the answers:** a score's probabilities and legend, which both System One and OpenAI Decisions return, and the
  `model` that answered, which System One returns. pi-ai's `model` is the model that was asked.

## Reading the answers

A yes-or-no answer is the probability of yes: near 1 means yes, near 0 means no, and near 0.5 means that the model is
unsure.

A score answer's `score` is the probability-weighted mean of the levels. For levels $0, \dots, n-1$ with
probabilities $p_i$:

$$\text{score} = \sum_{i=0}^{n-1} i \, p_i$$

In the System One example, $0 \cdot 0.0023 + 1 \cdot 0.116 + 2 \cdot 0.6753 + 3 \cdot 0.2064 \approx 2.09$: mostly
"today", leaning toward "right now". The probabilities show the whole spread, which the mean hides.

## Confidence

Choice and score answers carry a `confidence` from 0 to 1. It says how far the probabilities are from an even spread,
so a caller can act on confident answers and send the rest to a person. TypeSafe published the formulas, and
llama.cpp uses them.

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

pi-ai's chat-model API uses the choice formula for scores too. OpenAI's docs do not say how Luna computes its
confidence.

## How a model gets its probabilities

The providers' docs do not say how a model scores its options, but llama.cpp's server code shows two ways for the
open decision models:

- **Labels.** The prompt gives each option a short label, such as A, B and C, and the model's probabilities for the
  next token are read at those labels. Each label must be one token, so the number of labels limits the number of
  options: OpenJev uses A to Z and a to z, which gives 52. A chat model used as a classifier works the same way.
- **A reading per option.** The model reads each option, and the server reads the model's hidden state at the token
  that ends the option, for Kev, or at a mask token, for Laya, and turns it into a score. These models take up to 255
  options.

Either way, the model gives each option a raw score $s_i$, and a softmax with a temperature $T$ turns the scores into
probabilities:

$$p_i = \frac{e^{s_i / T}}{\sum_j e^{s_j / T}}$$

A decision model's temperature is stored in its model file. The model's makers fit it, and it can depend on the
question's type and its number of options. A model may also prefer the first label it sees. One of the open models,
lev, therefore reads a choice's options in two orders and averages the two results.

TypeSafe trains Jev "for calibrated decisions", and its docs add that "calibration is measured across groups of
predictions; it does not guarantee that an individual answer is correct". llama.cpp says the same of the open models:
the probabilities "are not guaranteed to be calibrated for your data". The same answer can also get different
probabilities from different models: in the llama.cpp blog, one vague ticket scored 0.25 on one model and 0.80 on
another. A cutoff such as "act above 0.9" has to be tested on the caller's own examples, for each model.

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
- OpenAI: the [Decisions guide](https://developers.openai.com/api/docs/guides/decisions).
- pi-ai 1.4.0 (`@earendil-works/pi-ai`): its README, section "Classification", its types in `dist/types.d.ts`, and its
  classifier APIs in `dist/api/`: `system-one-shared`, `typesafe-system-one`, `cloudflare-workers-ai-system-one`,
  `openai-decisions` and `llama-cpp-classify`.
