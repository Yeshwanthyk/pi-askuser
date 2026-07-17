/** Terminal-native multiple-choice questions for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 10;
const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LABEL_LENGTH = 120;
const MAX_OPTION_DESCRIPTION_LENGTH = 240;
const MAX_CONTEXT_LENGTH = 500;

const OptionSchema = Type.Object(
  {
    label: Type.String({
      minLength: 1,
      maxLength: MAX_OPTION_LABEL_LENGTH,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
    }),
    description: Type.Optional(
      Type.String({
        maxLength: MAX_OPTION_DESCRIPTION_LENGTH,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
      }),
    ),
  },
  { additionalProperties: false },
);

const QuestionSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.id,
    }),
    question: Type.String({
      minLength: 1,
      maxLength: MAX_QUESTION_LENGTH,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
    }),
    options: Type.Array(OptionSchema, {
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
    }),
    context: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_CONTEXT_LENGTH,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.context,
      }),
    ),
    optional: Type.Optional(
      Type.Boolean({
        default: false,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.optional,
      }),
    ),
  },
  { additionalProperties: false },
);

export const AskUserParams = Type.Object(
  {
    questions: Type.Array(QuestionSchema, {
      minItems: MIN_QUESTIONS,
      maxItems: MAX_QUESTIONS,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
    }),
    context: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_CONTEXT_LENGTH,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.sharedContext,
      }),
    ),
  },
  { additionalProperties: false },
);

export type AskUserInput = Static<typeof AskUserParams>;
type AskUserQuestion = AskUserInput["questions"][number];
type AskUserOption = AskUserQuestion["options"][number];

export interface AskUserAnswer {
  id: string;
  question: string;
  answer: string;
  wasCustom: boolean;
  index?: number;
}

export type AskUserStatus = "completed" | "dismissed" | "cancelled" | "no-ui";

export interface AskUserDetails {
  context?: string;
  questions: Array<{
    id: string;
    question: string;
    options: string[];
    optional: boolean;
    context?: string;
  }>;
  answers: AskUserAnswer[];
  skippedOptionalQuestionIds: string[];
  status: AskUserStatus;
  cancelled: boolean;
}

interface InteractionResult {
  answers: AskUserAnswer[];
  skippedOptionalQuestionIds: string[];
  status: "completed" | "dismissed" | "cancelled";
}

interface DisplayOption extends AskUserOption {
  kind: "answer" | "other" | "skip";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`${path} has unsupported field(s): ${extras.join(", ")}`);
  }
}

function parseNonEmptyString(value: unknown, path: string, maxLength?: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new Error(`${path} must be at most ${maxLength} characters`);
  }
  return value;
}

function parseContext(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const context = parseNonEmptyString(value, path);
  if (context.length > MAX_CONTEXT_LENGTH) {
    throw new Error(`${path} must be at most ${MAX_CONTEXT_LENGTH} characters`);
  }
  return context;
}

function parseOptions(value: unknown, path: string): AskUserOption[] {
  if (!Array.isArray(value) || value.length < MIN_OPTIONS || value.length > MAX_OPTIONS) {
    throw new Error(`${path} must contain ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
  }
  return value.map((option, index) => {
    const optionPath = `${path}[${index}]`;
    if (!isRecord(option)) throw new Error(`${optionPath} must be an object`);
    assertKeys(option, ["label", "description"], optionPath);
    const label = parseNonEmptyString(
      option.label,
      `${optionPath}.label`,
      MAX_OPTION_LABEL_LENGTH,
    );
    if (option.description !== undefined && typeof option.description !== "string") {
      throw new Error(`${optionPath}.description must be a string`);
    }
    if (
      option.description !== undefined &&
      option.description.length > MAX_OPTION_DESCRIPTION_LENGTH
    ) {
      throw new Error(
        `${optionPath}.description must be at most ${MAX_OPTION_DESCRIPTION_LENGTH} characters`,
      );
    }
    return option.description === undefined
      ? { label }
      : { label, description: option.description };
  });
}

function parseQuestion(value: unknown, index: number): AskUserQuestion {
  const path = `questions[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertKeys(value, ["id", "question", "options", "context", "optional"], path);
  const id = parseNonEmptyString(value.id, `${path}.id`);
  const question = parseNonEmptyString(
    value.question,
    `${path}.question`,
    MAX_QUESTION_LENGTH,
  );
  const options = parseOptions(value.options, `${path}.options`);
  const context = parseContext(value.context, `${path}.context`);
  if (value.optional !== undefined && typeof value.optional !== "boolean") {
    throw new Error(`${path}.optional must be a boolean`);
  }
  return {
    id,
    question,
    options,
    ...(context === undefined ? {} : { context }),
    ...(value.optional === undefined ? {} : { optional: value.optional }),
  };
}

/** Strictly parses the current `{ context?, questions }` input schema. */
export function parseAskUserArguments(args: unknown): AskUserInput {
  if (!isRecord(args)) throw new Error("ask_user arguments must be an object");
  assertKeys(args, ["questions", "context"], "ask_user arguments");
  if (
    !Array.isArray(args.questions) ||
    args.questions.length < MIN_QUESTIONS ||
    args.questions.length > MAX_QUESTIONS
  ) {
    throw new Error(`questions must contain ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions`);
  }
  const questions = args.questions.map(parseQuestion);
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.id)) {
      throw new Error(`questions must have unique ids (duplicate: ${question.id})`);
    }
    ids.add(question.id);
  }
  const context = parseContext(args.context, "context");
  return context === undefined ? { questions } : { questions, context };
}

export function buildAskUserDetails(
  input: AskUserInput,
  answers: AskUserAnswer[],
  skippedOptionalQuestionIds: string[],
  status: AskUserStatus,
): AskUserDetails {
  return {
    ...(input.context === undefined ? {} : { context: input.context }),
    questions: input.questions.map((question) => ({
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      optional: question.optional ?? false,
      ...(question.context === undefined ? {} : { context: question.context }),
    })),
    answers,
    skippedOptionalQuestionIds,
    status,
    cancelled: status === "cancelled",
  };
}

function isAskUserDetails(value: unknown): value is AskUserDetails {
  return (
    isRecord(value) &&
    Array.isArray(value.questions) &&
    Array.isArray(value.answers) &&
    Array.isArray(value.skippedOptionalQuestionIds) &&
    (value.status === "completed" ||
      value.status === "dismissed" ||
      value.status === "cancelled" ||
      value.status === "no-ui") &&
    typeof value.cancelled === "boolean"
  );
}

function displayOptions(question: AskUserQuestion): DisplayOption[] {
  return [
    ...question.options.map((option) => ({ ...option, kind: "answer" as const })),
    { label: "Write my own answer…", kind: "other" },
    ...(question.optional
      ? [{ label: "Skip this question", kind: "skip" as const }]
      : []),
  ];
}

export function findNextUnansweredIndex(
  questionIds: string[],
  resolvedIds: ReadonlySet<string>,
  current: number,
): number | undefined {
  for (let offset = 1; offset <= questionIds.length; offset++) {
    const index = (current + offset + questionIds.length) % questionIds.length;
    const id = questionIds[index];
    if (id !== undefined && !resolvedIds.has(id)) return index;
  }
  return undefined;
}

export function firstMissingRequiredIndex(
  questions: ReadonlyArray<Pick<AskUserQuestion, "id" | "optional">>,
  answeredIds: ReadonlySet<string>,
): number | undefined {
  const index = questions.findIndex(
    (question) => !question.optional && !answeredIds.has(question.id),
  );
  return index < 0 ? undefined : index;
}

export function savedOptionIndex(
  optionCount: number,
  answer: AskUserAnswer | undefined,
): number {
  if (!answer) return 0;
  if (answer.wasCustom) return optionCount;
  const index = (answer.index ?? 1) - 1;
  return Math.min(Math.max(index, 0), Math.max(0, optionCount - 1));
}

export function savedCustomText(answer: AskUserAnswer | undefined): string {
  return answer?.wasCustom ? answer.answer : "";
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = parseAskUserArguments(rawParams);
      const reply = (
        text: string,
        answers: AskUserAnswer[],
        skippedOptionalQuestionIds: string[],
        status: AskUserStatus,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: buildAskUserDetails(
          params,
          answers,
          skippedOptionalQuestionIds,
          status,
        ),
      });

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }), [], [], "no-ui");
      }
      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], [], "cancelled");
      }

      const showQuestions = (uiSignal: AbortSignal) =>
        ctx.ui.custom<InteractionResult>((tui, theme, keybindings, done) => {
          const multi = params.questions.length > 1;
          const answers = new Map<string, AskUserAnswer>();
          const skippedOptionalQuestionIds = new Set<string>();
          let current = 0;
          let optionIndex = 0;
          let editMode = false;
          let componentFocused = false;
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;
          let settled = false;

          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          };
          const editor = new Editor(tui, editorTheme);

          function finish(status: InteractionResult["status"]): void {
            if (settled) return;
            settled = true;
            uiSignal.removeEventListener("abort", abort);
            done({
              answers: [...answers.values()],
              skippedOptionalQuestionIds: [...skippedOptionalQuestionIds],
              status,
            });
          }

          function abort(): void {
            finish("cancelled");
          }

          function refresh(): void {
            cachedWidth = undefined;
            cachedLines = undefined;
            tui.requestRender();
          }

          function setEditMode(value: boolean): void {
            editMode = value;
            editor.focused = componentFocused && value;
          }

          function goTo(index: number): void {
            current = (index + params.questions.length + 1) % (params.questions.length + 1);
            const question = params.questions[current];
            const saved = question ? answers.get(question.id) : undefined;
            optionIndex = question
              ? skippedOptionalQuestionIds.has(question.id)
                ? displayOptions(question).length - 1
                : savedOptionIndex(question.options.length, saved)
              : 0;
            setEditMode(false);
            editor.setText(savedCustomText(saved));
            refresh();
          }

          function advanceAfterResolution(): void {
            if (!multi) {
              finish("completed");
              return;
            }
            const resolvedIds = new Set([
              ...answers.keys(),
              ...skippedOptionalQuestionIds,
            ]);
            const next = findNextUnansweredIndex(
              params.questions.map((question) => question.id),
              resolvedIds,
              current,
            );
            goTo(next ?? params.questions.length);
          }

          function saveAnswer(answer: AskUserAnswer): void {
            skippedOptionalQuestionIds.delete(answer.id);
            answers.set(answer.id, answer);
            advanceAfterResolution();
          }

          function skipQuestion(question: AskUserQuestion): void {
            if (!question.optional) return;
            answers.delete(question.id);
            skippedOptionalQuestionIds.add(question.id);
            advanceAfterResolution();
          }

          function selectOption(index: number): void {
            const question = params.questions[current];
            if (!question) return;
            const options = displayOptions(question);
            const selected = options[index];
            if (!selected) return;
            if (selected.kind === "other") {
              optionIndex = index;
              const saved = answers.get(question.id);
              editor.setText(savedCustomText(saved));
              setEditMode(true);
              refresh();
              return;
            }
            if (selected.kind === "skip") {
              skipQuestion(question);
              return;
            }
            saveAnswer({
              id: question.id,
              question: question.question,
              answer: selected.label,
              wasCustom: false,
              index: index + 1,
            });
          }

          editor.onSubmit = (value) => {
            const question = params.questions[current];
            const trimmed = value.trim();
            if (!question || !trimmed) {
              setEditMode(false);
              editor.setText(savedCustomText(answers.get(question?.id ?? "")));
              refresh();
              return;
            }
            saveAnswer({
              id: question.id,
              question: question.question,
              answer: trimmed,
              wasCustom: true,
            });
          };

          function handleInput(data: string): void {
            if (editMode) {
              if (keybindings.matches(data, "tui.select.cancel")) {
                const question = params.questions[current];
                setEditMode(false);
                editor.setText(savedCustomText(question ? answers.get(question.id) : undefined));
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (multi && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
              goTo(current + 1);
              return;
            }
            if (
              multi &&
              (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))
            ) {
              goTo(current - 1);
              return;
            }

            if (current === params.questions.length) {
              if (keybindings.matches(data, "tui.select.confirm")) {
                const firstMissing = firstMissingRequiredIndex(
                  params.questions,
                  new Set(answers.keys()),
                );
                if (firstMissing === undefined) {
                  finish("completed");
                } else {
                  goTo(firstMissing);
                }
              } else if (keybindings.matches(data, "tui.select.cancel")) {
                finish("dismissed");
              }
              return;
            }

            const question = params.questions[current];
            if (!question) return;
            const options = displayOptions(question);
            if (keybindings.matches(data, "tui.select.up")) {
              optionIndex = (optionIndex - 1 + options.length) % options.length;
              refresh();
              return;
            }
            if (keybindings.matches(data, "tui.select.down")) {
              optionIndex = (optionIndex + 1) % options.length;
              refresh();
              return;
            }
            if (data.length === 1 && data >= "1" && data <= String(options.length)) {
              selectOption(Number(data) - 1);
              return;
            }
            if (keybindings.matches(data, "tui.select.confirm")) {
              selectOption(optionIndex);
              return;
            }
            if (keybindings.matches(data, "tui.select.cancel")) finish("dismissed");
          }

          function render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            const renderWidth = Math.max(1, width);
            const lines: string[] = [];
            const add = (text: string) => lines.push(truncateToWidth(text, renderWidth));
            const addWrapped = (text: string, prefix = " ") => {
              const prefixWidth = visibleWidth(prefix);
              const available = Math.max(1, renderWidth - prefixWidth);
              const wrapped = wrapTextWithAnsi(text, available);
              const continuation = " ".repeat(prefixWidth);
              if (wrapped.length === 0) add(prefix);
              for (let index = 0; index < wrapped.length; index++) {
                add(`${index === 0 ? prefix : continuation}${wrapped[index]}`);
              }
            };
            const addContext = (context: string) => {
              addWrapped(theme.fg("muted", context));
              lines.push("");
            };

            const title = multi ? " Questions " : " Question ";
            add(
              theme.fg(
                "accent",
                `─${title}${"─".repeat(Math.max(0, renderWidth - title.length - 1))}`,
              ),
            );

            if (params.context) addContext(params.context);

            if (multi) {
              const position = current === params.questions.length ? "Review" : `${current + 1}/${params.questions.length}`;
              addWrapped(
                theme.fg(
                  "dim",
                  `${position} • ${answers.size} answered${skippedOptionalQuestionIds.size > 0 ? ` • ${skippedOptionalQuestionIds.size} skipped` : ""}`,
                ),
              );
              lines.push("");
            }

            if (current === params.questions.length) {
              addWrapped(theme.fg("text", theme.bold("Review answers")));
              lines.push("");
              for (const question of params.questions) {
                const answer = answers.get(question.id);
                const skipped = skippedOptionalQuestionIds.has(question.id);
                const value = answer
                  ? `${answer.wasCustom ? "(wrote) " : ""}${answer.answer}`
                  : skipped
                    ? "skipped (optional)"
                    : question.optional
                      ? "not answered (optional)"
                      : "missing (required)";
                addWrapped(
                  `${theme.fg("text", question.question)}${question.optional ? theme.fg("dim", " (optional)") : ""} ${theme.fg("dim", `[${question.id}]`)} — ${theme.fg(answer || skipped || question.optional ? "text" : "warning", value)}`,
                );
              }
              lines.push("");
              const firstMissing = firstMissingRequiredIndex(
                params.questions,
                new Set(answers.keys()),
              );
              if (firstMissing === undefined) {
                addWrapped(theme.fg("success", "Confirm to submit"));
              } else {
                addWrapped(
                  theme.fg("warning", "Confirm to answer the first missing required question"),
                );
              }
            } else {
              const question = params.questions[current];
              if (question) {
                if (question.context) addContext(question.context);
                addWrapped(
                  theme.fg("text", theme.bold(question.question)) +
                    (question.optional ? theme.fg("dim", " (optional)") : ""),
                );
                lines.push("");
                const options = displayOptions(question);
                for (let index = 0; index < options.length; index++) {
                  const option = options[index];
                  const selected = index === optionIndex;
                  const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
                  const marker = option.kind === "other"
                    ? "✎"
                    : option.kind === "skip"
                      ? "○"
                      : `${index + 1}.`;
                  const saved = answers.get(question.id);
                  const isStored = option.kind === "skip"
                    ? skippedOptionalQuestionIds.has(question.id)
                    : savedOptionIndex(question.options.length, saved) === index && saved !== undefined;
                  const color = selected || (option.kind === "other" && editMode)
                    ? "accent"
                    : option.kind === "answer"
                      ? "text"
                      : "muted";
                  const stored = isStored
                    ? theme.fg("success", option.kind === "skip" ? "  ✓ skipped" : "  ✓ saved")
                    : "";
                  addWrapped(`${theme.fg(color, `${marker} ${option.label}`)}${stored}`, prefix);
                  if (option.description) {
                    addWrapped(theme.fg("muted", option.description), "      ");
                  }
                }
                if (editMode) {
                  lines.push("");
                  add(theme.fg("muted", " Your answer:"));
                  for (const line of editor.render(Math.max(1, renderWidth - 2))) {
                    add(` ${line}`);
                  }
                }
              }
            }

            lines.push("");
            if (editMode) {
              addWrapped(
                theme.fg(
                  "dim",
                  "Confirm answer • Back to options • Dismiss from options",
                ),
              );
            } else if (multi) {
              const question = params.questions[current];
              const selection = question
                ? `Move or 1-${displayOptions(question).length} select`
                : "Review";
              addWrapped(
                theme.fg(
                  "dim",
                  `${selection} • Confirm • Tab/→ next • Shift+Tab/← back • Dismiss`,
                ),
              );
            } else {
              const optionCount = displayOptions(params.questions[0]).length;
              addWrapped(
                theme.fg(
                  "dim",
                  `Move or 1-${optionCount} select • Confirm • Back from custom answer • Dismiss`,
                ),
              );
            }
            add(theme.fg("accent", "─".repeat(renderWidth)));

            cachedWidth = width;
            cachedLines = lines;
            return lines;
          }

          uiSignal.addEventListener("abort", abort, { once: true });
          if (uiSignal.aborted) queueMicrotask(abort);

          const component: Focusable & {
            render: (width: number) => string[];
            invalidate: () => void;
            handleInput: (data: string) => void;
            dispose: () => void;
          } = {
            get focused() {
              return componentFocused;
            },
            set focused(value: boolean) {
              componentFocused = value;
              editor.focused = value && editMode;
            },
            render,
            invalidate: () => {
              cachedWidth = undefined;
              cachedLines = undefined;
              editor.invalidate();
            },
            handleInput,
            dispose: () => uiSignal.removeEventListener("abort", abort),
          };
          return component;
        });

      const uiExit = await Effect.runPromiseExit(
        Effect.tryPromise(showQuestions),
        signal ? { signal } : undefined,
      );

      if (Exit.isFailure(uiExit)) {
        if (Cause.hasInterruptsOnly(uiExit.cause)) {
          return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], [], "cancelled");
        }
        const [first] = Cause.prettyErrors(uiExit.cause);
        throw new Error(first?.message ?? Cause.pretty(uiExit.cause));
      }

      const result = uiExit.value;
      const resultQuestions = params.questions.map(({ id, question, optional }) => ({
        id,
        question,
        optional: optional ?? false,
      }));
      if (result.status === "cancelled") {
        return reply(
          buildAskUserResultMessage({ kind: "cancelled" }),
          result.answers,
          result.skippedOptionalQuestionIds,
          "cancelled",
        );
      }
      if (result.status === "dismissed") {
        return reply(
          buildAskUserResultMessage({
            kind: "dismissed",
            questions: resultQuestions,
            answers: result.answers,
            skippedOptionalQuestionIds: result.skippedOptionalQuestionIds,
          }),
          result.answers,
          result.skippedOptionalQuestionIds,
          "dismissed",
        );
      }
      return reply(
        buildAskUserResultMessage({
          kind: "completed",
          questions: resultQuestions,
          answers: result.answers,
          skippedOptionalQuestionIds: result.skippedOptionalQuestionIds,
        }),
        result.answers,
        result.skippedOptionalQuestionIds,
        "completed",
      );
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      try {
        const input = parseAskUserArguments(args);
        if (input.questions.length === 1) {
          const question = input.questions[0];
          text += theme.fg("muted", question.question);
          const options = question.options.map((option, index) => `${index + 1}. ${option.label}`);
          text += `\n${theme.fg("dim", `  ${options.join("  ")}`)}`;
        } else {
          text += theme.fg("muted", `${input.questions.length} questions`);
          text += ` ${theme.fg("dim", `(${input.questions.map((question) => question.id).join(", ")})`)}`;
        }
      } catch {
        text += theme.fg("warning", "invalid arguments");
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      if (!isAskUserDetails(result.details)) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      const details = result.details;
      if (details.status === "cancelled") {
        return new Text(theme.fg("warning", "✗ cancelled"), 0, 0);
      }
      if (details.status === "no-ui") {
        return new Text(theme.fg("warning", "○ not shown (no interactive UI)"), 0, 0);
      }
      const skippedIds = new Set(details.skippedOptionalQuestionIds);
      const rows = details.questions.map((question) => {
        const answer = details.answers.find((candidate) => candidate.id === question.id);
        const label = `${theme.fg("text", question.question)}${question.optional ? theme.fg("dim", " (optional)") : ""} ${theme.fg("dim", `[${question.id}]`)}`;
        if (!answer) {
          const value = question.optional
            ? skippedIds.has(question.id)
              ? "skipped (optional)"
              : "not answered (optional)"
            : "not answered (required)";
          return `${theme.fg(question.optional ? "muted" : "warning", "○ ")}${label}: ${value}`;
        }
        const value = answer.wasCustom
          ? `${theme.fg("muted", "(wrote) ")}${answer.answer}`
          : `${answer.index}. ${answer.answer}`;
        return `${theme.fg("success", "✓ ")}${label}: ${value}`;
      });
      if (details.status === "dismissed") {
        rows.unshift(
          theme.fg(
            "warning",
            `dismissed with ${details.answers.length}/${details.questions.length} answers`,
          ),
        );
      }
      return new Text(rows.join("\n"), 0, 0);
    },
  });
}
