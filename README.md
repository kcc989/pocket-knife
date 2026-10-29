<p align="center">
  <img src="assets/cover.svg" alt="switch: a framework for building decision-model harnesses for any kind of task" width="880">
</p>

# switch

switch is a TypeScript framework for building harnesses around decision models. It runs a model through a task one
step at a time: your code asks typed questions, and the model's answers move the task to its next state.

A decision model answers typed questions with probabilities and writes no text, so it cannot make the tool calls of
the usual agent loop. TypeSafe calls these models [System One models](https://docs.typesafe.ai/concepts/system-one),
and its Jev was the first; [llama.cpp serves open ones](https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp)
through the same API. switch works with any classifier model that
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) lists, as
[docs/DECISION_MODEL_API.md](docs/DECISION_MODEL_API.md) explains.

## Concepts

- **Domain:** your code for one kind of task, such as chess or routing a support ticket. It gives each case as a state
  machine.
- **Case:** one task of a domain, such as one game, loaded from a case folder.
- **State:** JSON with everything the domain needs to know about where a case is.
- **Question function:** gives the questions that the model must answer in a state. When it gives none, the run ends.
- **Question and answer:** a `bool`, `choice` or `score` question, by id. Every answer comes with the model's
  probabilities.
- **Pick:** a choice question whose answers are the state's **choices**, such as the legal moves. The `picking` helper
  builds it from a list of choices.
- **Transition function:** gives the next state from a state and the model's answers.
- **View function:** optional. Turns a state into what the model reads, within a token budget.
- **Step:** one round of questions, answers and transition.
- **Outcome:** optional. How a case ended in the domain's terms, such as "white wins".
- **Trace:** every state, question and answer of a run, in one file. A replay reads it and asks no model.
- **Harness:** a program that runs a domain on case folders, with switch's `run` and `replay` commands.

## How a run works

1. The domain makes the case's initial state.
2. The question function gives the state's questions. If there are none, the run ends.
3. The model reads the view of the state and answers every question.
4. The transition function makes the next state from the answers, and the run goes back to step 2.

A run also ends when a request fails, or at a step limit that a domain may set as a safety net.
[docs/MATH.md](docs/MATH.md) writes the loop down in symbols.

## Install

switch needs Node.js 22.18 or newer and pnpm. Add it to a project pinned to a commit:

```bash
pnpm add github:osolmaz/switch#<commit>
```

| Import                    | What it gives                                                        |
| ------------------------- | -------------------------------------------------------------------- |
| `@osolmaz/switch`         | The loop, the domain types, the pick helper, traces and replay       |
| `@osolmaz/switch/models`  | `piAiDecider`, which asks a classifier model that pi-ai lists        |
| `@osolmaz/switch/cli`     | `commandLine`, which gives a harness the `run` and `replay` commands |
| `@osolmaz/switch/testing` | A fake decider for tests that make no model calls                    |

## Examples

- [Rubric judge](examples/rubric-judge/README.md) grades a saved answer to a task against the task's rubric.
- [Chess](examples/chess/README.md) plays chess against random moves, Stockfish, or itself.
- [WikiRace](examples/wikirace/README.md) races from one Wikipedia article to another by following links.

## Write a domain

A domain gives `initial`, `questions` and `transition`, and optionally `view`. This one routes a support ticket. The
model reads logs one at a time until it picks stop, and then a last step asks which team gets the ticket.

```ts
import {
  type Choice,
  type ChoiceQuestion,
  type DomainShared,
  type JsonObject,
  picking,
  type StateMachine,
} from "@osolmaz/switch";

export interface Ticket {
  readonly text: string;
  readonly logs: Readonly<Record<string, string>>;
}

/** Where a ticket is: the logs read so far, with what each one said, whether reading is over, and the team. */
interface TriageState extends JsonObject {
  readonly read: readonly { readonly log: string; readonly text: string }[];
  readonly done: boolean;
  readonly team: string | null;
}

/** A log to read, or null to stop reading; the transition gets the choice back. */
interface ReadLog extends Choice {
  readonly log: string | null;
}

export const TRIAGE: DomainShared = { name: "triage", version: "0.1.0", limits: { steps: 20, windowShare: 0.9 } };

const TEAM: ChoiceQuestion = {
  type: "choice",
  instructions: "Which team should handle the ticket?",
  criteria: { billing: "Billing", infra: "Infrastructure", app: "Application" },
};

export function triageMachine(ticket: Ticket): StateMachine<TriageState> {
  const pick = picking<TriageState, ReadLog>({
    instructions: "Which log should be read next to route this ticket?",
    limit: 20,
    choices: (state) => [
      ...Object.keys(ticket.logs)
        .filter((log) => !state.read.some((entry) => entry.log === log))
        .map((log) => ({ type: "read-log", key: log, text: `Read ${log}`, log })),
      { type: "stop", key: "stop", text: "Stop reading: the evidence is enough", log: null, priority: -1 },
    ],
    transition: (state, { log }) =>
      Promise.resolve(
        log === null
          ? { ...state, done: true }
          : { ...state, read: [...state.read, { log, text: ticket.logs[log] ?? "" }] },
      ),
  });
  return {
    initial: () => Promise.resolve({ read: [], done: false, team: null }),
    questions: (state) => {
      if (state.team !== null) return {};
      return state.done ? { team: TEAM } : pick.questions(state);
    },
    transition: (state, answers) => {
      if (!state.done) return pick.transition(state, answers);
      const team = answers["team"];
      return Promise.resolve({ ...state, team: team?.type === "choice" ? team.choice : "unknown" });
    },
    view: (state) => Promise.resolve({ decisionState: { ticket: ticket.text, read: state.read } }),
  };
}
```

Run it with any classifier model that pi-ai lists. pi-ai finds the key in the environment, such as
`TYPESAFE_API_KEY`:

```ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { run } from "@osolmaz/switch";
import { piAiDecider } from "@osolmaz/switch/models";

const decider = piAiDecider("typesafe/jev-latest", { registry: builtinModels() });
const result = await run(TRIAGE, triageMachine(ticket), decider);
// result.state is the last state, result.trace the trace, and result.ended "done", "step limit" or "failed".
```

[docs/DOMAINS.md](docs/DOMAINS.md) has the rules of picks, stop choices, views, limits and choice types.

## Write a harness

A harness turns a domain into a program that runs case folders. Its setup returns a runner:

```ts
import { basename } from "node:path";
import { type Runner, runnerOf } from "@osolmaz/switch";
import { TRIAGE, triageMachine } from "./index.ts";
import { loadTicket } from "./load.ts";

export function triageSetup(): Promise<Runner> {
  return Promise.resolve(
    runnerOf({
      ...TRIAGE,
      caseId: (folder) => Promise.resolve(basename(folder)),
      load: async (folder) => triageMachine(await loadTicket(folder)),
      outcome: ({ state }) => ({ team: state.team }),
    }),
  );
}
```

`commandLine` makes it a program with `run` and `replay`. It is a [Commander](https://github.com/tj/commander.js)
program, so the harness can add commands of its own:

```ts
import { commandLine } from "@osolmaz/switch/cli";
import { triageSetup } from "./setup.ts";

await commandLine({ triage: { setup: triageSetup } })
  .name("triage")
  .parseAsync();
```

[docs/DOMAINS.md](docs/DOMAINS.md#harnesses) covers definitions, a domain's own flags and API keys.

## Run, watch and replay

```bash
examples/chess/src/main.ts run examples/chess/cases/white-seed-1 --out runs/chess
examples/chess/src/main.ts view runs/chess
examples/chess/src/main.ts replay examples/chess/cases/white-seed-1 runs/chess/cases/white-seed-1/trace.jsonl --fork 5 --out runs/fork
```

- `run` writes a run folder with each case's result, trace and requests. A stopped run goes on where it stopped.
- `view` plays a run back in the browser, step by step, and follows cases live. It is the
  [viewer](viewer/README.md), a separate package that the examples add.
- `replay` runs a case again from its trace without the model. With `--fork <n>`, it repeats the first n steps and
  lets a model go on from there.

[docs/DOMAINS.md](docs/DOMAINS.md#replay) says when a replay fails and what a run folder holds.

## License

[MIT](LICENSE)
