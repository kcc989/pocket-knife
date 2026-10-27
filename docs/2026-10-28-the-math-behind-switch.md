---
title: The math behind switch
author: Onur Solmaz
date: 2026-10-28
tags: [design, math]
---

# The math behind switch

## TL;DR

A switch run is a state machine whose state is the history of steps, and the menu is the function that gives the
allowed choices in each state. The model turns its scores for the menu's labels into probabilities and takes the
likeliest one. A choice only reads the world, so the trace of choices and observations rebuilds every menu of a run,
and a replay is exact. Each request must fit in 90% of the model's window, 57,600 of Jev's 64,000
tokens, and the view shrinks by 30% on each of up to two retries. The legal-judge example passes a rubric item when
min(P(meets), 1 − P(misses)) is at least 0.5.

## What this covers

switch is a TypeScript framework for harnesses around decision models: models that read a state, answer typed
questions with probabilities and write no text. The README's "How it works" names the parts of a run: world, history,
step, menu, choice, observation, view, question and answer. This doc writes down the math of each part, as the code
does it. It covers the state machine, what switch does to a menu, one pick by the model, a whole run, replay, the
token budget, and the verdicts and scores of the legal-judge example.

## World, history and steps

A case gives a **world** $W$: everything the case holds, such as a task and its files, or a chess position, a side
and an opponent. $W$ stays the same for the whole run.

A **step** is what one choice did. It has three parts: the choice's kind, such as `read` or `move`, its key, and its
observation $o$, the text (and sometimes images) that the choice found:

$$s = (\text{kind}, \text{key}, o)$$

The **history** after $t$ steps is the list of steps so far. It starts with the steps that the domain's `start`
function gives, such as the answer to grade or the first board:

$$h_0 = \text{start}(W), \qquad h_t = h_{t-1} \cdot s_t$$

Here $\cdot$ adds one step to the end of the list. Everything that changes during a run is in the history, and
nothing else changes.

## The menu as a state machine

The **menu** is the function at the center of a domain. It takes the world and the history and returns the list of
choices that make sense now:

$$M(W, h) = (c_1, \dots, c_m)$$

Each choice $c$ has a kind, a key, a text that the model reads, a priority, and a function that runs it. The run
function reads only the world, so what a choice finds depends on $W$ and nothing else:

$$o_c = \text{run}_c(W)$$

With these two parts, a run is a state machine. Its state is the history, and taking choice $c$ moves it to the next
state:

$$\delta(h, c) = h \cdot (\text{kind}_c, \text{key}_c, \text{run}_c(W)), \qquad c \in M(W, h)$$

The transition $\delta$ is the same for every domain: add one step. What differs between domains is the menu, which
says which choices are allowed in each state. A legal case can hold any number of files and a search can find any
text, so the states cannot be listed in advance. The menu works them out one at a time, when the run reaches each
one.

The textbook model for this is a Markov decision process. Its names map to switch's names as follows:

| Textbook name                 | switch name                             |
| ----------------------------- | --------------------------------------- |
| state $s$                     | history $h$, with the fixed world $W$   |
| set of allowed actions $A(s)$ | menu $M(W, h)$                          |
| transition                    | run the choice, then add its step       |
| policy $\pi(a \mid s)$        | the model's probabilities over the menu |
| terminal action               | stop                                    |

switch uses one word for what the model can pick, choice, as TypeSafe's API does.

## What switch does to a menu

The domain's menu function can return any list. Before the model sees it, switch's `buildMenu` in `src/core/menu.ts`
applies three rules, and then adds stop.

First, it removes every choice whose key is already in the history:

$$C = [\, c \in M(W, h) : \text{key}_c \notin \{\text{key}_s : s \in h\} \,]$$

Decision models tend to pick the same choice again once it is in the history; Pydantic AI warns about this for Jev.
The rule makes that impossible. A domain that needs to repeat something gives it a new key: a chess move's key holds
the ply number, such as `12:g1f3`, so the same move in a later position is a new choice.

Second, the keys and the texts in $C$ must all differ. Two equal texts would give the model two labels it cannot tell
apart, so switch stops the run with an error.

Third, switch keeps at most $L - 1$ choices, where $L$ is the `choices` limit. It keeps the ones with the smallest
priority value, the earliest first when priorities tie, and keeps them in the order the domain listed them. Then it
adds stop, so the model never sees more than $L$ entries.

The two examples set these values:

- legal-judge: $L = 30$. The first part of each file has priority 0, search hits 1, and the other parts 2, so the
  start of a file wins a place over its later parts.
- chess: $L = 220$, which leaves room for 219 moves. The largest number of legal moves known in any chess position is
  218, so the chess menu is never cut.

## One pick

A decision model never writes its pick as text. The model's API lists the menu under short labels, `o1` to `on` and
`stop` in switch's request, and reads the model's score $\ell_i$ for each label: its logit, the raw number the model
gives before any normalizing. The softmax turns the scores into probabilities that add up to 1:

$$p_i = \frac{e^{\ell_i / T}}{\sum_{j=1}^{n} e^{\ell_j / T}}$$

$T$ is the temperature. A value above 1 flattens the probabilities and a value below 1 sharpens them. switch sends
no temperature, so $T = 1$.

The answer's choice is the likeliest label:

$$i^* = \arg\max_i \, p_i$$

pi-ai's code for llama.cpp models takes this maximum, and TypeSafe's API returns its own `choice`, which switch takes
as given. switch draws nothing at random: the model's scores alone decide the pick.

The answer also has a **confidence**, which rescales the top probability $p_{\max} = p_{i^*}$ to the size of the
menu:

$$\text{conf} = \min\!\left(1,\; \max\!\left(0,\; \frac{n\,p_{\max} - 1}{n - 1}\right)\right)$$

It is 0 when every label is equally likely, $p_{\max} = 1/n$, and 1 when one label has all the probability. Between
those, it grows in a straight line with $p_{\max}$. The rescaling lets menus of different sizes be compared: a top
probability of 0.5 gives a confidence of 0 on a menu of 2 and $14/29 \approx 0.48$ on a menu of 30. TypeSafe
documents this formula, and pi-ai uses it for llama.cpp models too.

The other two question types use the same probabilities:

- A **bool** question has the labels true and false, and its answer is $P(\text{true}) = p_{\text{true}}$.
- A **score** question has levels $0, 1, \dots, k-1$. Its answer is the expected level, with the same confidence over
  the $k$ levels:

$$\text{score} = \sum_{i=0}^{k-1} i \, p_i$$

The viewer's confidence chart, in the chess page for example, draws the probability of the chosen choice at each
step. That is $p_{\max}$, before the rescaling.

## A whole run

The loop in `src/core/loop.ts` puts the parts together. With $L_{\text{steps}}$ the `steps` limit, a run goes:

1. Start with $h_0 = \text{start}(W)$.
2. For $t = 1, 2, \dots$: build the menu $m_t$ from $M(W, h_{t-1})$ by the rules above. If no choice is left, end
   with `empty menu`.
3. Ask the model to pick from $m_t$ and stop, over the view $V(W, h_{t-1})$. The view is the JSON state that the
   domain builds from the world and the history. The model gives the probabilities $p_t$ and the pick $c_t$.
4. If $c_t$ is stop, end with `stop`. Otherwise run it, $o_t = \text{run}_{c_t}(W)$, and add the step:
   $h_t = h_{t-1} \cdot (\text{kind}_{c_t}, \text{key}_{c_t}, o_t)$.
5. After $L_{\text{steps}}$ picks, end with `step limit`. If a request fails, end with `no choice`.
6. Ask the domain's questions $Q(W)$ over the view of the last history.

A run thus takes at most $L_{\text{steps}}$ steps, 8 in legal-judge and 200 in chess, and never more than the number
of different keys the menu can offer.

The trace keeps $p_t$ for every choice on every menu. From it, one number that switch does not compute but any tool
can: the probability that a model which drew each pick at random from $p_t$ would take this exact path,

$$P(\text{path}) = \prod_{t=1}^{T} p_t(c_t)$$

A long run of confident picks keeps this high, and one unsure step lowers it by its whole factor.

## Why a replay is exact

The menu and the view at step $t$ depend only on $W$ and $h_{t-1}$. The history $h_{t-1}$ is the start steps and
the pairs $(c_1, o_1), \dots, (c_{t-1}, o_{t-1})$. So, step by step from $h_0$, the trace's start steps, choices and
observations give back every history, every menu and every view of the run.

`replay` in `src/core/replay.ts` uses this. Its decider repeats each recorded choice $c_t$ and calls no model, and
each step takes the recorded $o_t$ and runs no choice. The replay thus gives the recorded run, even when a choice would
find something else now, such as a reply of Stockfish, which does not always pick the same move in the same position.

Two cases change this:

- A trace keeps only an image's label. A step whose observation has images runs again, and it must find the same
  source, text, image labels and data; otherwise the replay stops with an error.
- With `--fork n`, the first $n$ steps repeat as above, and from step $n + 1$ the model picks and the choices run.

`run --steps-from` repeats all $T$ steps of each case of an earlier run and asks only the questions again, so its
answers are a function of $W$, $h_T$, the definition and the model.

This is also why the world stays fixed. If a choice changed $W$, the trace would also need every change to $W$ to
rebuild a menu. With every change in the history, the trace is complete. In chess, the world holds the start position,
the side and the opponent, and the board after $t$ steps follows from the moves in the history. The engine is a
program outside the world, so its reply goes into the observation.

## Fitting a request into the window

A model reads at most $w$ tokens per request, its window: 64,000 for Jev. switch sizes every request before it sends
it, with these values:

- $\sigma$, the `windowShare` limit, 0.9 by default: the share of the window that a request may fill.
- $r$, characters per token: 3 by default in pi-ai, which overestimates the tokens of English text and JSON.
- $\hat{t}(x) = \lceil |\text{JSON}(x)| / r \rceil$, the estimated tokens of a value $x$.

The budget of a request is $B = \lfloor w \sigma \rfloor$, 57,600 tokens for Jev, or about 172,800 characters. The
questions come first, with any extra state that an answer stage adds, and the view gets the rest:

$$R_1 = B - \hat{t}(\text{questions})$$

The domain's `view` function gets $R$ and must build a state that fits it; legal-judge, for example, shortens or
leaves out evidence and notes what it left out. When the model's API says the request was still too long, switch
asks again with a smaller view, up to three requests in all:

$$R_{a+1} = \lfloor 0.7 \, R_a \rfloor$$

So the three views get $R_1$, about $0.7 R_1$ and about $0.49 R_1$ tokens.

The final questions can be many, such as two per rubric item in legal-judge, so switch splits them into batches. Each
batch may take $\lfloor 0.4 \, w \sigma \rfloor$ tokens of questions, 23,040 for Jev, which leaves room for the view.
switch fills the batches in order: a question goes into the current batch if it fits, and otherwise starts a new
one. A question larger than the room gets a batch of its own.

## Verdicts in legal-judge

The legal-judge example asks two bool questions about each rubric item: whether the answer meets the item, with
probability $a$, and whether it misses or contradicts any requirement, with probability $b$.
[Meets and misses](2026-10-26-meets-and-misses.md) explains why it asks two. The item passes when it meets the item
and misses nothing, and `combine` in `examples/legal-judge/src/judge.ts` gives that the probability

$$P(\text{pass}) = \min(a,\; 1 - b)$$

The model gives each of the two probabilities on its own, and says nothing about how the two relate. For any two
events, the probability that both are true is at most the smaller of their probabilities:

$$P(A \cap B) \le \min\big(P(A), P(B)\big)$$

The two sides are equal when the two checks agree as much as they can, so the minimum is the largest probability that
fits both answers. The product $a(1 - b)$ would assume that the two checks are independent, and they are not: both read
the same evidence about the same answer.

The verdict is pass when $P(\text{pass}) \ge 0.5$. With the minimum, that holds exactly when $a \ge 0.5$ and
$b \le 0.5$: the model says the answer meets the item, and says nothing is missed.

## Scores against labels

`score` in `examples/legal-judge/src/score/score.ts` compares the verdicts with reference labels. It counts the items
in four groups, by the judge's verdict and the label: $tp$ (both pass), $fp$ (the judge passes, the label fails), $fn$
(the judge fails, the label passes) and $tn$ (both fail), with $n$ items in all. From these:

$$\text{accuracy} = \frac{tp + tn}{n}, \qquad \text{balanced accuracy} = \frac{1}{2}\left(\frac{tp}{tp + fn} + \frac{tn}{tn + fp}\right)$$

Accuracy alone can look good for a judge that passes everything, when most items pass. Cohen's kappa corrects for
this. It compares the accuracy with $p_e$, the accuracy that a judge would get by chance if it passed the same share
of items but at random:

$$p_e = \frac{(tp + fp)(tp + fn) + (fn + tn)(fp + tn)}{n^2}, \qquad \kappa = \frac{\text{accuracy} - p_e}{1 - p_e}$$

A kappa of 1 is full agreement and 0 is no better than chance. When 90% of the items pass, a judge that passes every
item has an accuracy of 0.9 and a kappa of 0.

The report adds three more numbers:

- Items right over all scheduled items, where every item of a case without answers counts as wrong.
- Whole answers right: the judge's verdict on an answer is pass when every item passes, compared with the same for
  the labels.
- Accuracy by each rubric item's category, which `score` reads from the case folders.
