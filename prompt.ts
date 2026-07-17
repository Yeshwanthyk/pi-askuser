/** Model-facing schema descriptions for ask_user questions and answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  sharedContext:
    "Optional short evidence or rationale shown once above the question batch. Do not repeat a question here.",
  id: "Unique non-empty machine identifier for this question within the call",
  context:
    "Optional short evidence or rationale shown above this question. Do not repeat the question here.",
  optional:
    "Whether the user may skip this question. Defaults to false: required questions must be answered before submission. This is independent of optional context.",
  optionLabel: "Short non-empty display label for this option",
  optionDescription: "Optional one-line description shown below the label",
  question: "The non-empty user-facing question to ask",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
  questions:
    "Between 1 and 10 independent questions answerable now. Include as many independent questions as are useful; never batch contingent follow-ups that depend on earlier answers.",
};

export const ASK_USER_TOOL_DESCRIPTION =
  "Ask 1-10 independent multiple-choice questions answerable now. Each has 2-5 options plus an automatic free-form answer and may be marked optional so the user can skip it. Context may provide decision-relevant evidence or rationale. Never batch contingent follow-ups.";

export const ASK_USER_PROMPT_SNIPPET =
  "Ask 1-10 independent multiple-choice questions, with explicitly optional questions when appropriate";

export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking questions whose likely answers can be enumerated, use ask_user instead of asking in plain text.",
  "Choose 1-10 questions based on how many independent answers are useful now. Never batch contingent follow-ups that require a prior answer.",
  "Questions are required by default. Set a question's optional field to true only when proceeding without its answer is acceptable; this is unrelated to optional context.",
  "Use ask_user context only for evidence or rationale that helps the user decide; do not put or repeat the question itself in context.",
];

export interface ResultQuestion {
  id: string;
  question: string;
  optional: boolean;
}

export interface ResultAnswer extends Pick<ResultQuestion, "id" | "question"> {
  answer: string;
  wasCustom: boolean;
  index?: number;
}

/** Builds the behavioral tool-result message returned to the parent model. */
export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | {
        kind: "completed" | "dismissed";
        questions: ResultQuestion[];
        answers: ResultAnswer[];
        skippedOptionalQuestionIds: string[];
      },
): string {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the question(s) could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "The ask_user interaction was cancelled or aborted. Do not infer user intent from cancellation.";
    case "completed":
    case "dismissed": {
      const answersById = new Map(outcome.answers.map((answer) => [answer.id, answer]));
      const skippedIds = new Set(outcome.skippedOptionalQuestionIds);
      const lines = outcome.questions.map((question) => {
        const answer = answersById.get(question.id);
        const label = `[${question.id}] ${question.question}`;
        if (!answer) {
          if (question.optional) {
            return `${label}: ${skippedIds.has(question.id) ? "skipped (optional)" : "not answered (optional)"}`;
          }
          return `${label}: not answered (required)`;
        }
        if (answer.wasCustom) {
          return `${label}: user wrote: ${answer.answer}`;
        }
        return `${label}: user selected option ${answer.index}: ${answer.answer}`;
      });
      if (outcome.kind === "dismissed") {
        lines.unshift(
          "User dismissed the question UI. Preserve every collected answer; unanswered required and optional values are missing and must not be inferred.",
        );
      }
      return lines.join("\n");
    }
  }
}
