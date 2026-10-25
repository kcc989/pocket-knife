# jeval

jeval is a harness for decision models, such as TypeSafe's Jev, that lets them work through multi-step
tasks. At each step, code lists the steps that are allowed, the model picks one, and code runs it, until the
model can answer typed questions about the case.

Grading an answer against a rubric is the first use. The same loop can route a request, sort a report or
decide whether a case needs a person.

jeval has no code yet. The design and the work plan are in
[docs/2026-10-25-jeval-plan.md](docs/2026-10-25-jeval-plan.md).

## License

[MIT](LICENSE)
