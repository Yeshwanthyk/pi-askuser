/** Terminal-native multiple-choice questions for Pi. */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  Text,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
import {
  type AskUserAnswer,
  type InteractionQuestion,
} from "./interaction.ts";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";
import { createAskUserTui } from "./tui.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ARGS_ALLOWED_KEYS = ["questions", "context"];
const QUESTION_ALLOWED_KEYS = ["id", "question", "header", "options", "context", "optional", "multiSelect"];
const OPTION_ALLOWED_KEYS = ["label", "description"];

/**
 * Coerces provider-typical boolean noise ("true"/"false"/"yes"/"no"/"1"/"0")
 * to real booleans. Returns undefined when the value cannot be interpreted.
 */
function coerceBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "true":
      case "yes":
      case "1":
        return true;
      case "false":
      case "no":
      case "0":
      case "":
        return false;
    }
  }
  return undefined;
}

function normalizedText(value: unknown, present: boolean): { value: unknown; changed: boolean } {
  if (!present) return { value: undefined, changed: false };
  if (typeof value === "string" && value.trim().length > 0) return { value, changed: false };
  return { value: undefined, changed: true };
}

/**
 * Normalizes one option record: maps `aside` to `description` (a common
 * provider-only decoration), drops non-string descriptions, and strips every
 * unknown key. Returns the original when nothing needs changing.
 */
function normalizeOptionValue(option: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(option) || typeof option.label !== "string") {
    return { value: option, changed: false };
  }
  let changed = Object.keys(option).some((key) => !OPTION_ALLOWED_KEYS.includes(key));
  let description = option.description;
  if (description === undefined && typeof option.aside === "string") {
    description = Array.from(option.aside).slice(0, MAX_OPTION_DESCRIPTION_LENGTH).join("");
    changed = true;
  } else if (description !== undefined && typeof description !== "string") {
    description = undefined;
    changed = true;
  }
  if (option.aside !== undefined) changed = true;
  if (!changed) return { value: option, changed: false };
  const cleaned: Record<string, unknown> = { label: option.label };
  if (description !== undefined) cleaned.description = description;
  return { value: cleaned, changed: true };
}

/**
 * Normalizes one question record: strips unknown keys, drops null/empty
 * header and context values, coerces optional/multiSelect to real booleans,
 * and normalizes every option. Returns the original when unchanged.
 */
function normalizeQuestionValue(question: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(question)) return { value: question, changed: false };
  let changed = Object.keys(question).some((key) => !QUESTION_ALLOWED_KEYS.includes(key));

  const header = normalizedText(question.header, Object.prototype.hasOwnProperty.call(question, "header"));
  const context = normalizedText(question.context, Object.prototype.hasOwnProperty.call(question, "context"));
  if (header.changed || context.changed) changed = true;

  let optional: boolean | undefined;
  if (Object.prototype.hasOwnProperty.call(question, "optional")) {
    const coerced = coerceBooleanFlag(question.optional);
    optional = coerced;
    if (coerced !== question.optional) changed = true;
  }
  let multiSelect: boolean | undefined;
  if (Object.prototype.hasOwnProperty.call(question, "multiSelect")) {
    const coerced = coerceBooleanFlag(question.multiSelect);
    multiSelect = coerced;
    if (coerced !== question.multiSelect) changed = true;
  }

  let options = question.options;
  if (Array.isArray(options)) {
    let optionsChanged = false;
    const cleanedOptions = options.map((option) => {
      const result = normalizeOptionValue(option);
      if (result.changed) optionsChanged = true;
      return result.value;
    });
    if (optionsChanged) {
      changed = true;
      options = cleanedOptions;
    }
  }

  if (!changed) return { value: question, changed: false };
  const cleaned: Record<string, unknown> = { id: question.id, question: question.question, options };
  if (header.value !== undefined) cleaned.header = header.value;
  if (context.value !== undefined) cleaned.context = context.value;
  if (optional !== undefined) cleaned.optional = optional;
  if (multiSelect !== undefined) cleaned.multiSelect = multiSelect;
  return { value: cleaned, changed: true };
}

/**
 * Normalizes common provider-only decoration and noise without weakening the
 * public schema. Non-strict emitters (DeepSeek, Claude, OpenRouter proxies)
 * routinely add extra keys, string booleans, or null optional fields; this
 * strips or coerces them so the strict parse and validation only ever see
 * canonical input. Returns the original reference when nothing changed.
 */
export function normalizeAskUserArguments(args: unknown): unknown {
  if (!isRecord(args) || !Array.isArray(args.questions)) return args;
  let changed = Object.keys(args).some((key) => !ARGS_ALLOWED_KEYS.includes(key));

  const context = normalizedText(args.context, Object.prototype.hasOwnProperty.call(args, "context"));
  if (context.changed) changed = true;

  const questions = args.questions.map((question) => {
    const result = normalizeQuestionValue(question);
    if (result.changed) changed = true;
    return result.value;
  });

  if (!changed) return args;
  const cleaned: Record<string, unknown> = { questions };
  if (context.value !== undefined) cleaned.context = context.value;
  return cleaned;
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

export class InteractionQueueRegistry {
  private readonly queues = new WeakMap<object, InteractionQueue>();

  for(owner: object): InteractionQueue {
    const existing = this.queues.get(owner);
    if (existing !== undefined) return existing;
    const queue = new InteractionQueue();
    this.queues.set(owner, queue);
    return queue;
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
    const input = parseAskUserArguments(normalizeAskUserArguments(args));
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
  const interactionQueues = new InteractionQueueRegistry();

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
        const release = await interactionQueues.for(ctx.ui).acquire(signal);
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
        ctx.ui.custom<InteractionResult>((tui, theme, keybindings, done) =>
          createAskUserTui({
            params: {
              ...(params.context === undefined ? {} : { context: params.context }),
              questions: params.questions.map((question) => ({
                ...question,
                optional: question.optional ?? false,
                multiSelect: question.multiSelect ?? false,
              })),
            },
            questions,
            tui,
            theme,
            keybindings,
            signal: uiSignal,
            done,
          }),
        );

      const release = await interactionQueues.for(ctx.ui).acquire(signal);
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
        const label = `${theme.fg("text", question.header ?? question.question)}${question.optional ? theme.fg("dim", " (optional)") : ""}`;
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
