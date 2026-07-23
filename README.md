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
    header?: string; // compact progress/review label; non-empty, single-line, <=24 chars
    context?: string; // optional rationale/evidence shown above this question
    optional?: boolean; // default false; true allows the user to skip
    multiSelect?: boolean; // default false; true enables checkbox selection
    options: Array<{ // 2..5
      label: string;
      description?: string;
    }>;
  }>;
}
```

A free-form **Write my own answer…** row is appended automatically. `context` is optional explanatory content; it does not make a question optional. Questions are required unless `optional: true`. `header` is display-only; `id` remains the canonical identity.

Choose 1–10 questions based on how many independent answers are useful now. Do not batch contingent follow-ups whose wording or options require an earlier answer.

## Keyboard flow

### One question

- Configured selection up/down bindings move through options.
- For single-select questions, number keys choose immediately and Confirm submits the selected answer immediately; there is no review step.
- For multi-select questions, Space or a number toggles a configured checkbox. The custom editor preserves configured selections, and **Done selecting** explicitly commits the non-empty draft.
- The custom row opens an inline editor; cancel returns to options. A single-select custom answer submits immediately; a multi-select custom answer remains staged until Done.
- An optional question has a visible **Skip this question** row. Skipping immediately completes with an explicit optional-skip result.
- A required question has no skip action. Cancel from options dismisses the UI.

### Multiple questions

- Only the current question is expanded. Committing a single-select answer, committing a multi-select draft with **Done selecting**, or skipping an optional question advances to the next unresolved question.
- A batch containing only required single-select questions submits immediately when its final configured answer is selected.
- `Tab` / `→` and `Shift+Tab` / `←` navigate while retaining answers, skips, cursor position, and custom text.
- Returning to a skipped optional question shows its skipped state. Selecting an answer clears that state.
- Batches with optional, multi-select, or custom answers retain review, which distinguishes answered, skipped optional, untouched optional, and missing required questions.
- On review, Confirm submits once all required questions are answered; otherwise it jumps to the first missing required question.
- Cancel dismisses and returns every retained answer and explicit missing/skipped rows.

Tool aborts remain `cancelled`, distinct from user dismissal, and do not imply user intent. Concurrent calls are serialized so one interaction cannot displace another. In non-TUI modes the result instructs the model to ask in plain text.

The public schema remains strict. Before validation, the extension normalizes the common provider decoration `options[].aside`: it becomes `description` when no description exists and is otherwise discarded.

The UI fits itself to the current terminal row count. It keeps the selected option or editor visible, clips wrapped content with above/below indicators, and makes review content scrollable with Up/Down. Width and height changes invalidate the render cache and re-clamp the viewport.

## Result and partial-result management

Every question is enumerated in model-facing completed and dismissed text. Completed results mark unanswered optional questions as `skipped (optional)` or `not answered (optional)`. Dismissed results also mark unanswered required questions and explicitly instruct the model not to infer missing values.

Structured details use one shape for single and batched calls:

```ts
{
  context?: string;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    context?: string;
    optional: boolean; // always materialized; false by default
    multiSelect: boolean; // always materialized; false by default
    options: string[];
  }>;
  answers: Array<
    | {
        id: string;
        question: string;
        multiSelect?: false;
        answer: string;
        wasCustom: boolean;
        index?: number; // one-based configured option index; absent for custom
      }
    | {
        id: string;
        question: string;
        multiSelect: true;
        selections: Array<{
          answer: string;
          wasCustom: boolean;
          index?: number; // one-based configured option index; absent for custom
        }>;
      }
  >;
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
