import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  createInteractionState,
  customTextFor,
  draftFor,
  firstMissingRequiredIndex,
  isOptionSelected,
  orderedAnswers,
  orderedSkippedIds,
  reduceInteraction,
  shouldAutoCompleteSimpleBatch,
  type AskUserAnswer,
  type InteractionAction,
  type InteractionQuestion,
  type InteractionState,
} from "./interaction.ts";
import { fitViewport, type LineRange, markerLineRange } from "./viewport.ts";

export interface TuiQuestion extends InteractionQuestion {
  header?: string;
  context?: string;
  options: ReadonlyArray<{ label: string; description?: string }>;
}

export interface TuiParams {
  context?: string;
  questions: ReadonlyArray<TuiQuestion>;
}

export interface TuiInteractionResult {
  answers: AskUserAnswer[];
  skippedOptionalQuestionIds: string[];
  status: "completed" | "dismissed" | "cancelled";
}

interface DisplayOptionAnswer {
  label: string;
  description?: string;
  kind: "answer";
  configuredIndex: number;
}

type DisplayOption =
  | DisplayOptionAnswer
  | { label: string; kind: "other" }
  | { label: string; kind: "done" }
  | { label: string; kind: "skip" };

export interface AskUserTuiComponent extends Focusable {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  dispose(): void;
}

export interface AskUserTuiDependencies {
  params: TuiParams;
  questions: ReadonlyArray<InteractionQuestion>;
  tui: TUI;
  theme: Pick<Theme, "fg" | "bold">;
  keybindings: KeybindingsManager;
  signal: AbortSignal;
  done(result: TuiInteractionResult): void;
}

function displayOptions(question: InteractionQuestion): DisplayOption[] {
  return [
    ...question.options.map((option, configuredIndex) => ({
      ...option,
      kind: "answer" as const,
      configuredIndex,
    })),
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

function keyName(key: string): string {
  const names: Record<string, string> = {
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    enter: "Enter",
    escape: "Esc",
    tab: "Tab",
    "shift+tab": "Shift+Tab",
    space: "Space",
    "ctrl+c": "Ctrl+C",
  };
  return names[key] ?? key
    .split("+")
    .map((part) => part.length <= 2 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("+");
}

function bindingLabel(keybindings: KeybindingsManager, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): string {
  return keybindings.getKeys(binding).map(keyName).join("/");
}

function compactPreview(text: string, width: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return truncateToWidth(singleLine, Math.max(1, width));
}

export function createAskUserTui({
  params,
  questions,
  tui,
  theme,
  keybindings,
  signal,
  done,
}: AskUserTuiDependencies): AskUserTuiComponent {
  const batched = questions.length > 1;
  let state = createInteractionState();
  let editMode = false;
  let componentFocused = false;
  let reviewOffset = 0;
  let cachedWidth: number | undefined;
  let cachedHeight: number | undefined;
  let cachedLines: string[] | undefined;
  let validationMessage: string | undefined;
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
    signal.removeEventListener("abort", abort);
    done({
      answers: state.status === "cancelled" ? [] : orderedAnswers(questions, state),
      skippedOptionalQuestionIds: state.status === "cancelled" ? [] : orderedSkippedIds(questions, state),
      status: state.status,
    });
  }

  function refresh(): void {
    cachedWidth = undefined;
    cachedHeight = undefined;
    cachedLines = undefined;
    tui.requestRender();
  }

  function dispatch(action: InteractionAction): void {
    const previous = state;
    state = reduceInteraction(questions, state, action);
    if (action.type === "commitMulti" && state === previous) {
      const question = params.questions[state.current];
      const draft = question === undefined ? undefined : draftFor(state, question.id);
      const hasSelection = (draft?.optionIndices.length ?? 0) > 0 || (draft?.customText?.trim().length ?? 0) > 0;
      validationMessage = question?.multiSelect && !question.optional && !hasSelection
        ? "Select at least one option before Done."
        : undefined;
    } else {
      validationMessage = undefined;
    }
    refresh();
    finishFromState();
  }

  function abort(): void { dispatch({ type: "cancel" }); }

  function setEditMode(value: boolean): void {
    editMode = value;
    editor.focused = componentFocused && value;
  }

  function currentQuestion(): TuiQuestion | undefined {
    return params.questions[state.current];
  }

  function configuredSelectionWillSubmit(question: InteractionQuestion): boolean {
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

  function savedCustomText(question: InteractionQuestion): string {
    const draftText = customTextFor(state, question.id);
    if (draftText.length > 0) return draftText;
    const answer = state.answers[question.id];
    if (answer?.multiSelect === true) {
      return answer.selections.find((selection) => selection.wasCustom)?.answer ?? "";
    }
    return answer?.wasCustom ? answer.answer : "";
  }

  function goTo(index: number): void {
    dispatch({ type: "navigate", index: (index + questions.length + 1) % (questions.length + 1) });
    setEditMode(false);
    const question = currentQuestion();
    editor.setText(question ? savedCustomText(question) : "");
    reviewOffset = 0;
  }

  function setCursor(question: InteractionQuestion, index: number): void {
    const options = displayOptions(question);
    const current = state.optionIndices[question.id] ?? 0;
    dispatch({ type: "moveCursor", delta: index - current, optionCount: options.length });
  }

  function openEditor(question: InteractionQuestion, index: number): void {
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
        addWrappedTo(body, `${theme.fg("text", `${index + 1}. ${compact}`)}${question.optional ? theme.fg("dim", " (optional)") : ""} — ${theme.fg(answer || skipped || question.optional ? "text" : "warning", value)}`);
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
        let actionsStarted = false;
        for (let index = 0; index < options.length; index++) {
          const option = options[index];
          if (!option) continue;
          if (option.kind !== "answer" && !actionsStarted) {
            body.push(theme.fg("dim", " Actions"));
            actionsStarted = true;
          }
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
            if (option.kind === "answer") marker = `${option.configuredIndex + 1} ${configuredSelected ? "[x]" : "[ ]"}`;
            else if (option.kind === "other") marker = customSelected ? "[x]" : "[ ]";
            else marker = option.kind === "done" ? "✓" : "○";
          } else if (option.kind === "answer") marker = `${option.configuredIndex + 1}.`;
          else marker = option.kind === "other" ? "✎" : "○";
          const color = selected || (option.kind === "other" && editMode) ? "accent" : option.kind === "answer" ? "text" : "muted";
          const feedback = option.kind === "done" && validationMessage
            ? ` ${theme.fg("warning", `— ${validationMessage}`)}`
            : "";
          const stored = savedSelection
            ? theme.fg("success", "  ✓ saved")
            : option.kind === "skip" && state.skippedIds.includes(question.id) ? theme.fg("success", "  ✓ skipped") : "";
          addWrappedTo(body, `${theme.fg(color, `${marker} ${option.label}`)}${feedback}${stored}`, prefix);
          if (option.kind === "other") {
            const preview = savedCustomText(question);
            if (preview.length > 0 && !editMode) {
              addWrappedTo(body, theme.fg("muted", `↳ saved: ${compactPreview(preview, renderWidth - 12)}`), "      ");
            }
          }
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

    const up = bindingLabel(keybindings, "tui.select.up");
    const down = bindingLabel(keybindings, "tui.select.down");
    const confirm = bindingLabel(keybindings, "tui.select.confirm");
    const cancel = bindingLabel(keybindings, "tui.select.cancel");
    const move = `${up}/${down} Move`;
    const next = "Tab/Right next";
    const back = "Shift+Tab/Left back";
    if (editMode) addWrappedTo(footer, theme.fg("dim", `${confirm} Confirm answer • ${cancel} Cancel edit`));
    else if (batched) {
      const footerQuestion = currentQuestion();
      const instructions = state.current === questions.length
        ? `${up}/${down} Scroll • ${confirm} Submit • ${cancel} Dismiss`
        : footerQuestion?.multiSelect
          ? `${move} • Space/1–${footerQuestion.options.length} Toggle • ${confirm} Confirm (Done commits) • ${next} • ${back} • ${cancel} Dismiss`
          : footerQuestion !== undefined && configuredSelectionWillSubmit(footerQuestion)
            ? `${move} • 1–${footerQuestion.options.length} Select • ${confirm} Confirm (submits) • ${next} • ${back} • ${cancel} Dismiss`
            : `${move} • 1–${footerQuestion?.options.length ?? 0} Select • ${confirm} Confirm • ${next} • ${back} • ${cancel} Dismiss`;
      addWrappedTo(footer, theme.fg("dim", instructions));
    } else {
      const question = params.questions[0];
      const instructions = question?.multiSelect
        ? `${move} • Space/1–${question.options.length} Toggle • ${confirm} Confirm (Done commits) • ${cancel} Dismiss`
        : `${move} • 1–${question?.options.length ?? 0} Select • ${confirm} Confirm • ${cancel} Dismiss`;
      addWrappedTo(footer, theme.fg("dim", instructions));
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

  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) queueMicrotask(abort);
  return {
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
    dispose: () => signal.removeEventListener("abort", abort),
  };
}
