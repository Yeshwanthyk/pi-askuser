/** Terminal-native multiple-choice questions for Pi. */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
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
  type AskUserAnswer,
  createInteractionState,
  customTextFor,
  draftFor,
  findNextUnresolvedIndex,
  firstMissingRequiredIndex,
  isOptionSelected,
  orderedAnswers,
  orderedSkippedIds,
  reduceInteraction,
  shouldAutoCompleteSimpleBatch,
  type InteractionQuestion,
  type InteractionState,
} from "./interaction.ts";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";
import { fitViewport, type LineRange, markerLineRange } from "./viewport.ts";

export type { AskUserAnswer, AskUserSelection } from "./interaction.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 10;
const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LABEL_LENGTH = 120;
const MAX_OPTION_DESCRIPTION_LENGTH = 240;
const MAX_CONTEXT_LENGTH = 500;
const MAX_HEADER_LENGTH = 24;
const NON_WHITESPACE_PATTERN = "\\S";

const OptionSchema = Type.Object(
  {
    label: Type.String({
      minLength: 1,
      maxLength: MAX_OPTION_LABEL_LENGTH,
      pattern: NON_WHITESPACE_PATTERN,
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
      pattern: NON_WHITESPACE_PATTERN,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.id,
    }),
    question: Type.String({
      minLength: 1,
      maxLength: MAX_QUESTION_LENGTH,
      pattern: NON_WHITESPACE_PATTERN,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
    }),
    header: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_HEADER_LENGTH,
        pattern: "^(?=.*\\S)[^\\r\\n]+$",
        description: ASK_USER_PARAMETER_DESCRIPTIONS.header,
      }),
    ),
    options: Type.Array(OptionSchema, {
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
    }),
    context: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_CONTEXT_LENGTH,
        pattern: NON_WHITESPACE_PATTERN,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.context,
      }),
    ),
    optional: Type.Optional(
      Type.Boolean({ default: false, description: ASK_USER_PARAMETER_DESCRIPTIONS.optional }),
    ),
    multiSelect: Type.Optional(
      Type.Boolean({ default: false, description: ASK_USER_PARAMETER_DESCRIPTIONS.multiSelect }),
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
        pattern: NON_WHITESPACE_PATTERN,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.sharedContext,
      }),
    ),
  },
  { additionalProperties: false },
);

export type AskUserInput = Static<typeof AskUserParams>;
type AskUserQuestion = AskUserInput["questions"][number];
type AskUserOption = AskUserQuestion["options"][number];
export type AskUserStatus = "completed" | "dismissed" | "cancelled" | "no-ui";

export interface AskUserDetails {
  context?: string;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    options: string[];
    optional: boolean;
    multiSelect: boolean;
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

type DisplayOption =
  | (AskUserOption & { kind: "answer"; configuredIndex: number })
  | { label: string; kind: "other" }
  | { label: string; kind: "done" }
  | { label: string; kind: "skip" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalizes common provider-only decoration without weakening the public schema. */
export function normalizeAskUserArguments(args: unknown): unknown {
  if (!isRecord(args) || !Array.isArray(args.questions)) return args;
  let changed = false;
  const questions = args.questions.map((question) => {
    if (!isRecord(question) || !Array.isArray(question.options)) return question;
    let questionChanged = false;
    const options = question.options.map((option) => {
      if (!isRecord(option) || !("aside" in option)) return option;
      changed = true;
      questionChanged = true;
      const { aside, ...normalized } = option;
      if (normalized.description === undefined && typeof aside === "string") {
        normalized.description = Array.from(aside).slice(0, MAX_OPTION_DESCRIPTION_LENGTH).join("");
      }
      return normalized;
    });
    return questionChanged ? { ...question, options } : question;
  });
  return changed ? { ...args, questions } : args;
}

export class InteractionQueue {
  private tail: Promise<void> = Promise.resolve();

  async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
    let releaseSlot = (): void => {};
    const slot = new Promise<void>((resolve) => { releaseSlot = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => slot);

    if (signal?.aborted) {
      releaseSlot();
      return undefined;
    }
    if (signal === undefined) {
      await previous;
    } else {
      let abort = (): void => {};
      const aborted = new Promise<"aborted">((resolve) => {
        abort = () => resolve("aborted");
        signal.addEventListener("abort", abort, { once: true });
      });
      const outcome = await Promise.race([
        previous.then(() => "ready" as const),
        aborted,
      ]);
      signal.removeEventListener("abort", abort);
      if (outcome === "aborted") {
        releaseSlot();
        return undefined;
      }
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  }
}

function assertKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${path} has unsupported field(s): ${extras.join(", ")}`);
}

function parseNonEmptyString(value: unknown, path: string, maxLength?: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (maxLength !== undefined && Array.from(value).length > maxLength) {
    throw new Error(`${path} must be at most ${maxLength} characters`);
  }
  return value;
}

function parseContext(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return parseNonEmptyString(value, path, MAX_CONTEXT_LENGTH);
}

function parseHeader(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const header = parseNonEmptyString(value, path, MAX_HEADER_LENGTH);
  if (header.includes("\n") || header.includes("\r")) {
    throw new Error(`${path} must be a single line`);
  }
  return header;
}

function parseOptions(value: unknown, path: string): AskUserOption[] {
  if (!Array.isArray(value) || value.length < MIN_OPTIONS || value.length > MAX_OPTIONS) {
    throw new Error(`${path} must contain ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
  }
  return value.map((option, index) => {
    const optionPath = `${path}[${index}]`;
    if (!isRecord(option)) throw new Error(`${optionPath} must be an object`);
    assertKeys(option, ["label", "description"], optionPath);
    const label = parseNonEmptyString(option.label, `${optionPath}.label`, MAX_OPTION_LABEL_LENGTH);
    if (option.description !== undefined && typeof option.description !== "string") {
      throw new Error(`${optionPath}.description must be a string`);
    }
    if (
      typeof option.description === "string" &&
      Array.from(option.description).length > MAX_OPTION_DESCRIPTION_LENGTH
    ) {
      throw new Error(`${optionPath}.description must be at most ${MAX_OPTION_DESCRIPTION_LENGTH} characters`);
    }
    return option.description === undefined ? { label } : { label, description: option.description };
  });
}

function parseQuestion(value: unknown, index: number): AskUserQuestion {
  const path = `questions[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertKeys(value, ["id", "question", "header", "options", "context", "optional", "multiSelect"], path);
  const id = parseNonEmptyString(value.id, `${path}.id`);
  const question = parseNonEmptyString(value.question, `${path}.question`, MAX_QUESTION_LENGTH);
  const header = parseHeader(value.header, `${path}.header`);
  const options = parseOptions(value.options, `${path}.options`);
  const context = parseContext(value.context, `${path}.context`);
  if (value.optional !== undefined && typeof value.optional !== "boolean") {
    throw new Error(`${path}.optional must be a boolean`);
  }
  if (value.multiSelect !== undefined && typeof value.multiSelect !== "boolean") {
    throw new Error(`${path}.multiSelect must be a boolean`);
  }
  return {
    id,
    question,
    options,
    ...(header === undefined ? {} : { header }),
    ...(context === undefined ? {} : { context }),
    ...(value.optional === undefined ? {} : { optional: value.optional }),
    ...(value.multiSelect === undefined ? {} : { multiSelect: value.multiSelect }),
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
    if (ids.has(question.id)) throw new Error(`questions must have unique ids (duplicate: ${question.id})`);
    ids.add(question.id);
  }
  const context = parseContext(args.context, "context");
  return {
    questions,
    ...(context === undefined ? {} : { context }),
  };
}

function interactionQuestions(input: AskUserInput): InteractionQuestion[] {
  return input.questions.map((question) => ({
    id: question.id,
    question: question.question,
    options: question.options,
    optional: question.optional ?? false,
    multiSelect: question.multiSelect ?? false,
  }));
}

// Headless fallback: outside the TUI (RPC/web clients like pi-web/pican),
// ctx.ui.custom() is unavailable, but the standard dialog methods
// (select/input/confirm) travel over pi's extension_ui_request protocol and
// render in any client that implements it. This is the canonical degradation
// path for interactive extensions: ctx.ui.custom() when mode === "tui",
// standard dialogs otherwise.
const OTHER_CHOICE = "✏️ Other…";
const SKIP_CHOICE = "⏭ Skip (optional)";
const DONE_CHOICE = "✓ Done";

interface DialogUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

function choiceLabel(option: { label: string; description?: string }): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

export async function runDialogInteraction(
  ui: DialogUI,
  input: AskUserInput,
  questions: InteractionQuestion[],
  signal: AbortSignal | undefined,
): Promise<InteractionResult> {
  const answers: AskUserAnswer[] = [];
  const skippedOptionalQuestionIds: string[] = [];
  const dismissed = (): InteractionResult => ({ answers, skippedOptionalQuestionIds, status: "dismissed" });

  if (input.context) ui.notify?.(input.context, "info");

  for (const [index, question] of questions.entries()) {
    if (signal?.aborted) return { answers: [], skippedOptionalQuestionIds: [], status: "cancelled" };
    const source = input.questions[index];
    const labels = source.options.map(choiceLabel);
    const title = source.context ? `${question.question} (${source.context})` : question.question;

    if (!question.multiSelect) {
      const choices = [...labels, OTHER_CHOICE, ...(question.optional ? [SKIP_CHOICE] : [])];
      let resolved = false;
      while (!resolved) {
        const picked = await ui.select(title, choices);
        if (picked === undefined) return dismissed();
        if (picked === SKIP_CHOICE) {
          skippedOptionalQuestionIds.push(question.id);
          resolved = true;
        } else if (picked === OTHER_CHOICE) {
          const custom = await ui.input(title, "Type your answer");
          if (custom === undefined) continue; // back to the options
          answers.push({ id: question.id, question: question.question, answer: custom, wasCustom: true });
          resolved = true;
        } else {
          const optionIndex = choices.indexOf(picked);
          answers.push({
            id: question.id,
            question: question.question,
            answer: source.options[optionIndex]?.label ?? picked,
            wasCustom: false,
            index: optionIndex,
          });
          resolved = true;
        }
      }
      continue;
    }

    const selectedIndices = new Set<number>();
    const customTexts: string[] = [];
    let done = false;
    while (!done) {
      const choices = [
        ...labels.map((label, i) => `${selectedIndices.has(i) ? "[x]" : "[ ]"} ${label}`),
        ...customTexts.map((text) => `[x] ${text}`),
        OTHER_CHOICE,
        DONE_CHOICE,
        ...(question.optional ? [SKIP_CHOICE] : []),
      ];
      const picked = await ui.select(`${title} (select all that apply)`, choices);
      if (picked === undefined) return dismissed();
      if (picked === SKIP_CHOICE) {
        skippedOptionalQuestionIds.push(question.id);
        done = true;
      } else if (picked === OTHER_CHOICE) {
        const custom = await ui.input(title, "Type your answer");
        if (custom !== undefined) customTexts.push(custom);
      } else if (picked === DONE_CHOICE) {
        if (selectedIndices.size === 0 && customTexts.length === 0) {
          if (question.optional) {
            skippedOptionalQuestionIds.push(question.id);
          } else {
            ui.notify?.("Select at least one option", "warning");
            continue;
          }
        } else {
          const selections = [
            ...[...selectedIndices].sort((a, b) => a - b).map((i) => ({
              answer: source.options[i].label,
              wasCustom: false,
              index: i,
            })),
            ...customTexts.map((text) => ({ answer: text, wasCustom: true })),
          ];
          answers.push({ id: question.id, question: question.question, multiSelect: true, selections });
        }
        done = true;
      } else {
        const choiceIndex = choices.indexOf(picked);
        if (choiceIndex >= 0 && choiceIndex < labels.length) {
          if (selectedIndices.has(choiceIndex)) selectedIndices.delete(choiceIndex);
          else selectedIndices.add(choiceIndex);
        } else {
          const customIndex = choiceIndex - labels.length;
          if (customIndex >= 0 && customIndex < customTexts.length) customTexts.splice(customIndex, 1);
        }
      }
    }
  }

  return { answers, skippedOptionalQuestionIds, status: "completed" };
}

export function buildAskUserDetails(
  input: AskUserInput,
  answers: AskUserAnswer[],
  skippedOptionalQuestionIds: string[],
  status: AskUserStatus,
): AskUserDetails {
  const scrubIntent = status === "cancelled" || status === "no-ui";
  return {
    ...(input.context === undefined ? {} : { context: input.context }),
    questions: input.questions.map((question) => ({
      id: question.id,
      question: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      options: question.options.map((option) => option.label),
      optional: question.optional ?? false,
      multiSelect: question.multiSelect ?? false,
      ...(question.context === undefined ? {} : { context: question.context }),
    })),
    answers: scrubIntent ? [] : answers,
    skippedOptionalQuestionIds: scrubIntent ? [] : skippedOptionalQuestionIds,
    status,
    cancelled: status === "cancelled",
  };
}

function isSelection(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.answer === "string" &&
    typeof value.wasCustom === "boolean" &&
    (value.index === undefined || typeof value.index === "number")
  );
}

function isAnswer(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.question !== "string") return false;
  if (value.multiSelect === true) return Array.isArray(value.selections) && value.selections.length > 0 && value.selections.every(isSelection);
  return value.multiSelect === undefined || value.multiSelect === false
    ? typeof value.answer === "string" && typeof value.wasCustom === "boolean"
    : false;
}

function isDetailQuestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.question === "string" &&
    (value.header === undefined || typeof value.header === "string") &&
    Array.isArray(value.options) &&
    typeof value.optional === "boolean" &&
    (value.multiSelect === undefined || typeof value.multiSelect === "boolean")
  );
}

function isAskUserDetails(value: unknown): value is AskUserDetails {
  return (
    isRecord(value) &&
    Array.isArray(value.questions) && value.questions.every(isDetailQuestion) &&
    Array.isArray(value.answers) && value.answers.every(isAnswer) &&
    Array.isArray(value.skippedOptionalQuestionIds) &&
    (value.status === "completed" || value.status === "dismissed" || value.status === "cancelled" || value.status === "no-ui") &&
    typeof value.cancelled === "boolean"
  );
}

function displayOptions(question: AskUserQuestion): DisplayOption[] {
  return [
    ...question.options.map((option, configuredIndex) => ({ ...option, kind: "answer" as const, configuredIndex })),
    { label: "Write my own answer…", kind: "other" },
    ...(question.multiSelect ? [{ label: "Done selecting", kind: "done" as const }] : []),
    ...(question.optional ? [{ label: "Skip this question", kind: "skip" as const }] : []),
  ];
}

function answerText(answer: AskUserAnswer): string {
  if (answer.multiSelect === true) {
    return answer.selections
      .map((selection) => selection.wasCustom ? `(wrote) ${selection.answer}` : `${selection.index}. ${selection.answer}`)
      .join("; ");
  }
  return answer.wasCustom ? `(wrote) ${answer.answer}` : `${answer.index}. ${answer.answer}`;
}

export function renderAskUserCall(
  args: unknown,
  theme: Pick<Theme, "fg" | "bold">,
  argsComplete: boolean,
): Text {
  let text = theme.fg("toolTitle", theme.bold("ask_user"));
  if (!argsComplete) return new Text(text, 0, 0);
  text += " ";
  try {
    const input = parseAskUserArguments(args);
    if (input.questions.length === 1) {
      const question = input.questions[0];
      if (question === undefined) return new Text(text, 0, 0);
      text += theme.fg("muted", question.header ?? question.question);
      const options = question.options.map((option, index) => `${index + 1}. ${option.label}`);
      text += `\n${theme.fg("dim", `  ${options.join("  ")}`)}`;
    } else {
      text += theme.fg("muted", `${input.questions.length} questions`);
      text += ` ${theme.fg("dim", `(${input.questions.map((question) => question.header ?? question.id).join(", ")})`)}`;
    }
  } catch {
    text += theme.fg("warning", "invalid arguments");
  }
  return new Text(text, 0, 0);
}

export default function askUser(pi: ExtensionAPI) {
  const interactionQueue = new InteractionQueue();

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,
    prepareArguments(args) {
      return parseAskUserArguments(normalizeAskUserArguments(args));
    },

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = parseAskUserArguments(rawParams);
      const questions = interactionQuestions(params);
      const reply = (
        text: string,
        answers: AskUserAnswer[],
        skippedOptionalQuestionIds: string[],
        status: AskUserStatus,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: buildAskUserDetails(params, answers, skippedOptionalQuestionIds, status),
      });

      if (signal?.aborted) return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], [], "cancelled");

      if (ctx.mode !== "tui") {
        // Headless (RPC/web client): fall back to the standard dialog methods,
        // which travel over pi's extension_ui_request protocol.
        if (typeof ctx.ui?.select !== "function" || typeof ctx.ui?.input !== "function") {
          return reply(buildAskUserResultMessage({ kind: "no-ui" }), [], [], "no-ui");
        }
        const release = await interactionQueue.acquire(signal);
        if (release === undefined) {
          return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], [], "cancelled");
        }
        let result: InteractionResult;
        try {
          result = await runDialogInteraction(ctx.ui, params, questions, signal);
        } finally {
          release();
        }
        const resultQuestions = params.questions.map(({ id, question, optional }) => ({ id, question, optional: optional ?? false }));
        if (result.status === "cancelled") return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], [], "cancelled");
        const outcome = {
          kind: result.status,
          questions: resultQuestions,
          answers: result.answers,
          skippedOptionalQuestionIds: result.skippedOptionalQuestionIds,
        } as const;
        return reply(buildAskUserResultMessage(outcome), result.answers, result.skippedOptionalQuestionIds, result.status);
      }

      const showQuestions = (uiSignal: AbortSignal) =>
        ctx.ui.custom<InteractionResult>((tui, theme, keybindings, done) => {
          const batched = questions.length > 1;
          let state = createInteractionState();
          let editMode = false;
          let componentFocused = false;
          let reviewOffset = 0;
          let cachedWidth: number | undefined;
          let cachedHeight: number | undefined;
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

          function finishFromState(): void {
            if (settled || state.status === "active") return;
            settled = true;
            uiSignal.removeEventListener("abort", abort);
            done({
              answers: state.status === "cancelled" ? [] : orderedAnswers(questions, state),
              skippedOptionalQuestionIds: state.status === "cancelled" ? [] : orderedSkippedIds(questions, state),
              status: state.status,
            });
          }

          function dispatch(action: Parameters<typeof reduceInteraction>[2]): void {
            state = reduceInteraction(questions, state, action);
            refresh();
            finishFromState();
          }

          function abort(): void { dispatch({ type: "cancel" }); }

          function refresh(): void {
            cachedWidth = undefined;
            cachedHeight = undefined;
            cachedLines = undefined;
            tui.requestRender();
          }

          function setEditMode(value: boolean): void {
            editMode = value;
            editor.focused = componentFocused && value;
          }

          function currentQuestion(): AskUserQuestion | undefined {
            return params.questions[state.current];
          }

          function configuredSelectionWillSubmit(question: AskUserQuestion): boolean {
            const firstOption = question.options[0];
            if (firstOption === undefined) return false;
            return shouldAutoCompleteSimpleBatch(questions, {
              ...state,
              answers: {
                ...state.answers,
                [question.id]: {
                  id: question.id,
                  question: question.question,
                  answer: firstOption.label,
                  wasCustom: false,
                  index: 1,
                },
              },
            });
          }

          function savedCustomText(question: AskUserQuestion): string {
            const draftText = customTextFor(state, question.id);
            if (draftText.length > 0) return draftText;
            const answer = state.answers[question.id];
            return answer !== undefined && answer.multiSelect !== true && answer.wasCustom
              ? answer.answer
              : "";
          }

          function goTo(index: number): void {
            dispatch({ type: "navigate", index: (index + questions.length + 1) % (questions.length + 1) });
            setEditMode(false);
            const question = currentQuestion();
            editor.setText(question ? savedCustomText(question) : "");
            reviewOffset = 0;
          }

          function setCursor(question: AskUserQuestion, index: number): void {
            const options = displayOptions(question);
            const current = state.optionIndices[question.id] ?? 0;
            dispatch({ type: "moveCursor", delta: index - current, optionCount: options.length });
          }

          function openEditor(question: AskUserQuestion, index: number): void {
            setCursor(question, index);
            editor.setText(savedCustomText(question));
            setEditMode(true);
            refresh();
          }

          function activate(index: number): void {
            const question = currentQuestion();
            if (!question) return;
            const option = displayOptions(question)[index];
            if (!option) return;
            setCursor(question, index);
            if (option.kind === "other") openEditor(question, index);
            else if (option.kind === "skip") dispatch({ type: "skip" });
            else if (option.kind === "done") dispatch({ type: "commitMulti" });
            else dispatch({ type: "selectOption", optionIndex: option.configuredIndex });
          }

          editor.onSubmit = (value) => {
            const question = currentQuestion();
            if (!question) return;
            const trimmed = value.trim();
            setEditMode(false);
            if (question.multiSelect && trimmed.length === 0) dispatch({ type: "removeCustom" });
            else if (trimmed.length > 0) dispatch({ type: "submitCustom", text: trimmed });
            else refresh();
          };

          function handleInput(data: string): void {
            if (editMode) {
              if (keybindings.matches(data, "tui.select.cancel")) {
                const question = currentQuestion();
                setEditMode(false);
                editor.setText(question ? savedCustomText(question) : "");
                refresh();
              } else {
                editor.handleInput(data);
                refresh();
              }
              return;
            }

            if (batched && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
              goTo(state.current + 1);
              return;
            }
            if (batched && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
              goTo(state.current - 1);
              return;
            }

            if (state.current === questions.length) {
              if (keybindings.matches(data, "tui.select.up")) {
                reviewOffset = Math.max(0, reviewOffset - 1);
                refresh();
              } else if (keybindings.matches(data, "tui.select.down")) {
                reviewOffset += 1;
                refresh();
              } else if (keybindings.matches(data, "tui.select.confirm")) {
                const missing = firstMissingRequiredIndex(questions, state);
                if (missing === undefined) dispatch({ type: "complete" });
                else goTo(missing);
              } else if (keybindings.matches(data, "tui.select.cancel")) dispatch({ type: "dismiss" });
              return;
            }

            const question = currentQuestion();
            if (!question) return;
            const options = displayOptions(question);
            const selected = state.optionIndices[question.id] ?? 0;
            if (keybindings.matches(data, "tui.select.up")) dispatch({ type: "moveCursor", delta: -1, optionCount: options.length });
            else if (keybindings.matches(data, "tui.select.down")) dispatch({ type: "moveCursor", delta: 1, optionCount: options.length });
            else if (data.length === 1 && data >= "1" && Number(data) <= question.options.length) activate(Number(data) - 1);
            else if (question.multiSelect && matchesKey(data, Key.space)) activate(selected);
            else if (keybindings.matches(data, "tui.select.confirm")) activate(selected);
            else if (keybindings.matches(data, "tui.select.cancel")) dispatch({ type: "dismiss" });
          }

          function render(width: number): string[] {
            const height = Math.max(0, tui.terminal.rows);
            if (cachedLines && cachedWidth === width && cachedHeight === height) return cachedLines;
            const renderWidth = Math.max(1, width);
            const header: string[] = [];
            const body: string[] = [];
            const footer: string[] = [];
            let anchor: LineRange | undefined;
            const addTo = (target: string[], text: string) => target.push(truncateToWidth(text, renderWidth));
            const addWrappedTo = (target: string[], text: string, prefix = " ") => {
              const prefixWidth = visibleWidth(prefix);
              const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
              const continuation = " ".repeat(prefixWidth);
              if (wrapped.length === 0) addTo(target, prefix);
              for (let index = 0; index < wrapped.length; index++) {
                addTo(target, `${index === 0 ? prefix : continuation}${wrapped[index]}`);
              }
            };
            const addContext = (text: string) => {
              addWrappedTo(body, theme.fg("muted", text));
              body.push("");
            };

            const activeQuestion = currentQuestion();
            const titleText = activeQuestion?.header ?? (batched ? "Questions" : "Question");
            const title = ` ${titleText} `;
            addTo(header, theme.fg("accent", `─${title}${"─".repeat(Math.max(0, renderWidth - visibleWidth(title) - 1))}`));
            if (params.context) addContext(params.context);
            if (batched) {
              const position = state.current === questions.length ? "Review" : `${state.current + 1}/${questions.length}`;
              addWrappedTo(header, theme.fg("dim", `${position} • ${Object.keys(state.answers).length} answered${state.skippedIds.length > 0 ? ` • ${state.skippedIds.length} skipped` : ""}`));
            }

            if (state.current === questions.length) {
              addWrappedTo(body, theme.fg("text", theme.bold("Review answers")));
              body.push("");
              for (let index = 0; index < params.questions.length; index++) {
                const question = params.questions[index];
                if (!question) continue;
                const answer = state.answers[question.id];
                const skipped = state.skippedIds.includes(question.id);
                const value = answer ? answerText(answer) : skipped ? "skipped (optional)" : question.optional ? "not answered (optional)" : "missing (required)";
                const compact = question.header ?? question.question;
                addWrappedTo(body, `${theme.fg("text", `${index + 1}. ${compact}`)}${question.optional ? theme.fg("dim", " (optional)") : ""} ${theme.fg("dim", `[${question.id}]`)} — ${theme.fg(answer || skipped || question.optional ? "text" : "warning", value)}`);
              }
              body.push("");
              const missing = firstMissingRequiredIndex(questions, state);
              addWrappedTo(body, theme.fg(missing === undefined ? "success" : "warning", missing === undefined ? "Confirm to submit" : "Confirm to answer the first missing required question"));
            } else {
              const question = currentQuestion();
              if (question) {
                if (question.context) addContext(question.context);
                addWrappedTo(body, theme.fg("text", theme.bold(question.question)) + (question.optional ? theme.fg("dim", " (optional)") : ""));
                body.push("");
                const options = displayOptions(question);
                for (let index = 0; index < options.length; index++) {
                  const option = options[index];
                  if (!option) continue;
                  const rowStart = body.length;
                  const selected = index === (state.optionIndices[question.id] ?? 0);
                  const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
                  const draft = draftFor(state, question.id);
                  const savedAnswer = state.answers[question.id];
                  const customSelected = option.kind === "other" && (
                    question.multiSelect
                      ? draft.customText !== undefined
                      : savedAnswer !== undefined && savedAnswer.multiSelect !== true && savedAnswer.wasCustom
                  );
                  const configuredSelected = option.kind === "answer" && (
                    question.multiSelect
                      ? isOptionSelected(state, question.id, option.configuredIndex)
                      : savedAnswer !== undefined && savedAnswer.multiSelect !== true && !savedAnswer.wasCustom && savedAnswer.index === option.configuredIndex + 1
                  );
                  const savedSelection = option.kind === "answer"
                    ? savedAnswer?.multiSelect === true
                      ? savedAnswer.selections.some((selection) => !selection.wasCustom && selection.index === option.configuredIndex + 1)
                      : configuredSelected
                    : option.kind === "other"
                      ? savedAnswer?.multiSelect === true
                        ? savedAnswer.selections.some((selection) => selection.wasCustom)
                        : customSelected
                      : false;
                  let marker: string;
                  if (question.multiSelect) {
                    if (option.kind === "answer") marker = configuredSelected ? "[x]" : "[ ]";
                    else if (option.kind === "other") marker = customSelected ? "[x]" : "[ ]";
                    else marker = option.kind === "done" ? "✓" : "○";
                  } else if (option.kind === "answer") marker = `${option.configuredIndex + 1}.`;
                  else marker = option.kind === "other" ? "✎" : "○";
                  const color = selected || (option.kind === "other" && editMode) ? "accent" : option.kind === "answer" ? "text" : "muted";
                  const stored = savedSelection
                    ? theme.fg("success", "  ✓ saved")
                    : option.kind === "skip" && state.skippedIds.includes(question.id) ? theme.fg("success", "  ✓ skipped") : "";
                  addWrappedTo(body, `${theme.fg(color, `${marker} ${option.label}`)}${stored}`, prefix);
                  if (option.kind === "answer" && option.description) {
                    addWrappedTo(body, theme.fg("muted", option.description), "      ");
                  }
                  if (selected) anchor = { start: rowStart, end: body.length };
                }
                if (editMode) {
                  const rowStart = body.length;
                  body.push("");
                  addTo(body, theme.fg("muted", " Your answer:"));
                  const editorLines = editor.render(Math.max(1, renderWidth - 2));
                  const cursorAnchor = markerLineRange(editorLines, CURSOR_MARKER, body.length);
                  for (const line of editorLines) addTo(body, ` ${line}`);
                  anchor = cursorAnchor ?? { start: rowStart, end: body.length };
                }
              }
            }

            if (editMode) addWrappedTo(footer, theme.fg("dim", "Confirm answer • Back to options"));
            else if (batched) {
              const footerQuestion = currentQuestion();
              const instructions = state.current === questions.length
                ? "↑/↓ scroll • Press Confirm to submit • Tab/→ next • Shift+Tab/← back • Dismiss"
                : footerQuestion?.multiSelect
                  ? "Move • Space/number toggle • Done commits • Tab/→ next • Dismiss"
                  : footerQuestion !== undefined && configuredSelectionWillSubmit(footerQuestion)
                    ? "Move or number select • Selecting submits • Dismiss"
                    : "Move or number select • Confirm • Tab/→ next • Dismiss";
              addWrappedTo(footer, theme.fg("dim", instructions));
            }
            else {
              const question = params.questions[0];
              addWrappedTo(footer, theme.fg("dim", question?.multiSelect ? "Move • Space/number toggle • Confirm/Done • Dismiss" : "Move or number select • Confirm • Dismiss"));
            }
            addTo(footer, theme.fg("accent", "─".repeat(renderWidth)));

            const viewport = fitViewport({
              rows: height,
              header,
              body,
              footer,
              anchor,
              ...(state.current === questions.length ? { offset: reviewOffset } : {}),
            });
            if (state.current === questions.length) reviewOffset = viewport.bodyStart;
            cachedWidth = width;
            cachedHeight = height;
            cachedLines = viewport.lines.map((line) => truncateToWidth(line, renderWidth));
            return cachedLines;
          }

          uiSignal.addEventListener("abort", abort, { once: true });
          if (uiSignal.aborted) queueMicrotask(abort);
          const component: Focusable & {
            render: (width: number) => string[];
            invalidate: () => void;
            handleInput: (data: string) => void;
            dispose: () => void;
          } = {
            get focused() { return componentFocused; },
            set focused(value: boolean) {
              componentFocused = value;
              editor.focused = value && editMode;
            },
            render,
            invalidate: () => {
              cachedWidth = undefined;
              cachedHeight = undefined;
              cachedLines = undefined;
              editor.invalidate();
            },
            handleInput,
            dispose: () => uiSignal.removeEventListener("abort", abort),
          };
          return component;
        });

      const release = await interactionQueue.acquire(signal);
      if (release === undefined) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], [], "cancelled");
      }
      const uiExit = await (async () => {
        try {
          return await Effect.runPromiseExit(Effect.tryPromise(showQuestions), signal ? { signal } : undefined);
        } finally {
          release();
        }
      })();
      if (Exit.isFailure(uiExit)) {
        if (Cause.hasInterruptsOnly(uiExit.cause)) return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], [], "cancelled");
        const [first] = Cause.prettyErrors(uiExit.cause);
        throw new Error(first?.message ?? Cause.pretty(uiExit.cause));
      }

      const result = uiExit.value;
      const resultQuestions = params.questions.map(({ id, question, optional }) => ({ id, question, optional: optional ?? false }));
      if (result.status === "cancelled") return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], [], "cancelled");
      const outcome = {
        kind: result.status,
        questions: resultQuestions,
        answers: result.answers,
        skippedOptionalQuestionIds: result.skippedOptionalQuestionIds,
      } as const;
      return reply(buildAskUserResultMessage(outcome), result.answers, result.skippedOptionalQuestionIds, result.status);
    },

    renderCall(args, theme, context) {
      return renderAskUserCall(args, theme, context.argsComplete);
    },

    renderResult(result, _options, theme, _context) {
      if (!isAskUserDetails(result.details)) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      const details = result.details;
      if (details.status === "cancelled") return new Text(theme.fg("warning", "✗ cancelled"), 0, 0);
      if (details.status === "no-ui") return new Text(theme.fg("warning", "○ not shown (no interactive UI)"), 0, 0);
      const skippedIds = new Set(details.skippedOptionalQuestionIds);
      const rows = details.questions.map((question) => {
        const answer = details.answers.find((candidate) => candidate.id === question.id);
        const label = `${theme.fg("text", question.header ?? question.question)}${question.optional ? theme.fg("dim", " (optional)") : ""} ${theme.fg("dim", `[${question.id}]`)}`;
        if (!answer) {
          const value = question.optional ? skippedIds.has(question.id) ? "skipped (optional)" : "not answered (optional)" : "not answered (required)";
          return `${theme.fg(question.optional ? "muted" : "warning", "○ ")}${label}: ${value}`;
        }
        return `${theme.fg("success", "✓ ")}${label}: ${answerText(answer)}`;
      });
      if (details.status === "dismissed") rows.unshift(theme.fg("warning", `dismissed with ${details.answers.length}/${details.questions.length} answers`));
      return new Text(rows.join("\n"), 0, 0);
    },
  });
}
