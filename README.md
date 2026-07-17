# pi-askuser

Private Pi package providing the terminal-native `ask_user` tool.

Extracted from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup), commit `9b3ba1ad6aedfd932f9624044a5b996e0655dcca`.

## Tool schema

`ask_user` accepts only this strict input shape:

```ts
{
  context?: string; // optional shared rationale/evidence, shown once
  questions: Array<{ // 1..10; ids must be unique and non-empty
    id: string; // stable machine key
    question: string; // user-facing text
    context?: string; // optional rationale/evidence shown above this question
    optional?: boolean; // default false; true allows the user to skip
    options: Array<{ // 2..5
      label: string;
      description?: string;
    }>;
  }>;
}
```

A free-form **Write my own answer…** row is appended automatically. `context` is optional explanatory content; it does not make a question optional. Questions are required unless `optional: true`.

Choose 1–10 questions based on how many independent answers are useful now. Do not batch contingent follow-ups whose wording or options require an earlier answer.

## Keyboard flow

### One question

- Configured selection up/down bindings move through options.
- Number keys choose immediately.
- Confirm submits the selected answer immediately; there is no review step.
- The custom row opens an inline editor; cancel returns to options.
- An optional question has a visible **Skip this question** row. Skipping immediately completes with an explicit optional-skip result.
- A required question has no skip action. Cancel from options dismisses the UI.

### Multiple questions

- Only the current question is expanded; choosing an answer or skipping an optional question advances to the next unresolved question.
- `Tab` / `→` and `Shift+Tab` / `←` navigate while retaining answers, skips, cursor position, and custom text.
- Returning to a skipped optional question shows its skipped state. Selecting an answer clears that state.
- Review distinguishes answered, skipped optional, untouched optional, and missing required questions.
- Confirm submits once all required questions are answered; optional questions may remain skipped or unanswered. Otherwise it jumps to the first missing required question.
- Cancel dismisses and returns every retained answer and explicit missing/skipped rows.

Tool aborts remain `cancelled`, distinct from user dismissal, and do not imply user intent. In non-TUI modes the result instructs the model to ask in plain text.

## Result and partial-result management

Every question is enumerated in model-facing completed and dismissed text. Completed results mark unanswered optional questions as `skipped (optional)` or `not answered (optional)`. Dismissed results also mark unanswered required questions and explicitly instruct the model not to infer missing values.

Structured details use one shape for single and batched calls:

```ts
{
  context?: string;
  questions: Array<{
    id: string;
    question: string;
    context?: string;
    optional: boolean; // always materialized; false by default
    options: string[];
  }>;
  answers: Array<{
    id: string;
    question: string;
    answer: string;
    wasCustom: boolean;
    index?: number; // one-based model option index
  }>;
  skippedOptionalQuestionIds: string[];
  status: "completed" | "dismissed" | "cancelled" | "no-ui";
  cancelled: boolean; // true only for cancellation/abort
}
```

Outcome semantics:

- `completed`: all required questions were answered; optional questions may be answered, skipped, or untouched.
- `dismissed`: the user dismissed the UI; collected answers and every missing row are preserved.
- `cancelled`: the interaction was cancelled/aborted; no user intent should be inferred.
- `no-ui`: no interactive UI was available.

## Development

```sh
npm install
npm test
npm run check
```
