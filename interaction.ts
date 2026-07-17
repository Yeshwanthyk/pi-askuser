export interface InteractionQuestion {
  id: string;
  question: string;
  options: ReadonlyArray<{ label: string }>;
  optional: boolean;
  multiSelect: boolean;
}

export interface AskUserSelection {
  answer: string;
  wasCustom: boolean;
  index?: number;
}

export type AskUserAnswer =
  | ({ id: string; question: string; multiSelect?: false } & AskUserSelection)
  | {
      id: string;
      question: string;
      multiSelect: true;
      selections: AskUserSelection[];
    };

export interface SelectionDraft {
  optionIndices: number[];
  customText?: string;
}

export type InteractionStatus = "active" | "completed" | "dismissed" | "cancelled";

export interface InteractionState {
  status: InteractionStatus;
  current: number;
  optionIndices: Record<string, number>;
  drafts: Record<string, SelectionDraft>;
  answers: Record<string, AskUserAnswer>;
  skippedIds: string[];
}

export type InteractionAction =
  | { type: "moveCursor"; delta: number; optionCount: number }
  | { type: "navigate"; index: number }
  | { type: "selectOption"; optionIndex: number }
  | { type: "submitCustom"; text: string }
  | { type: "removeCustom" }
  | { type: "commitMulti" }
  | { type: "skip" }
  | { type: "dismiss" }
  | { type: "cancel" }
  | { type: "complete" };

export function createInteractionState(): InteractionState {
  return {
    status: "active",
    current: 0,
    optionIndices: {},
    drafts: {},
    answers: {},
    skippedIds: [],
  };
}

function questionAt(
  questions: ReadonlyArray<InteractionQuestion>,
  state: InteractionState,
): InteractionQuestion | undefined {
  return questions[state.current];
}

function selectionFor(question: InteractionQuestion, draft: SelectionDraft): AskUserSelection[] {
  const configured = [...new Set(draft.optionIndices)]
    .filter((index) =>
      Number.isInteger(index) &&
      index >= 0 &&
      index < question.options.length &&
      question.options[index]?.label.trim().length !== 0
    )
    .sort((left, right) => left - right)
    .map((index) => ({
      answer: question.options[index]?.label ?? "",
      wasCustom: false,
      index: index + 1,
    }));
  const customText = draft.customText?.trim();
  return customText === undefined || customText.length === 0
    ? configured
    : [...configured, { answer: customText, wasCustom: true }];
}

export function draftFor(state: InteractionState, id: string): SelectionDraft {
  return state.drafts[id] ?? { optionIndices: [] };
}

export function customTextFor(state: InteractionState, id: string): string {
  return draftFor(state, id).customText ?? "";
}

export function isOptionSelected(
  state: InteractionState,
  id: string,
  optionIndex: number,
): boolean {
  return draftFor(state, id).optionIndices.includes(optionIndex);
}

export function isQuestionAnswered(state: InteractionState, id: string): boolean {
  const answer = state.answers[id];
  if (answer === undefined) return false;
  if (answer.multiSelect === true) {
    return answer.selections.some((selection) => selection.answer.trim().length > 0);
  }
  return answer.answer.trim().length > 0;
}

export function firstMissingRequiredIndex(
  questions: ReadonlyArray<Pick<InteractionQuestion, "id" | "optional">>,
  state: InteractionState,
): number | undefined {
  const index = questions.findIndex(
    (question) => !question.optional && !isQuestionAnswered(state, question.id),
  );
  return index < 0 ? undefined : index;
}

export function findNextUnresolvedIndex(
  questions: ReadonlyArray<Pick<InteractionQuestion, "id">>,
  state: InteractionState,
  current: number,
): number | undefined {
  for (let offset = 1; offset <= questions.length; offset++) {
    const index = (current + offset + questions.length) % questions.length;
    const question = questions[index];
    if (
      question !== undefined &&
      !isQuestionAnswered(state, question.id) &&
      !state.skippedIds.includes(question.id)
    ) {
      return index;
    }
  }
  return undefined;
}

export function orderedAnswers(
  questions: ReadonlyArray<Pick<InteractionQuestion, "id">>,
  state: InteractionState,
): AskUserAnswer[] {
  return questions.flatMap((question) => {
    const answer = state.answers[question.id];
    return answer === undefined ? [] : [answer];
  });
}

export function orderedSkippedIds(
  questions: ReadonlyArray<Pick<InteractionQuestion, "id">>,
  state: InteractionState,
): string[] {
  return questions
    .filter((question) => state.skippedIds.includes(question.id))
    .map((question) => question.id);
}

function removeKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const entries = Object.entries(record).filter(([candidate]) => candidate !== key);
  return Object.fromEntries(entries);
}

function withResolvedAdvance(
  questions: ReadonlyArray<InteractionQuestion>,
  state: InteractionState,
): InteractionState {
  if (questions.length === 1) return { ...state, status: "completed" };
  const next = findNextUnresolvedIndex(questions, state, state.current);
  return { ...state, current: next ?? questions.length };
}

export function reduceInteraction(
  questions: ReadonlyArray<InteractionQuestion>,
  state: InteractionState,
  action: InteractionAction,
): InteractionState {
  if (state.status !== "active") return state;
  if (action.type === "cancel") {
    return { ...createInteractionState(), status: "cancelled" };
  }
  if (action.type === "dismiss") return { ...state, status: "dismissed" };
  if (action.type === "navigate") {
    if (!Number.isInteger(action.index)) return state;
    const current = Math.min(Math.max(action.index, 0), questions.length);
    return { ...state, current };
  }
  if (action.type === "complete") {
    return firstMissingRequiredIndex(questions, state) === undefined
      ? { ...state, status: "completed" }
      : state;
  }

  const question = questionAt(questions, state);
  if (question === undefined) return state;
  if (action.type === "moveCursor") {
    if (action.optionCount < 1) return state;
    if (!Number.isInteger(action.optionCount) || !Number.isFinite(action.delta)) return state;
    const current = state.optionIndices[question.id] ?? 0;
    const optionIndex = ((current + action.delta) % action.optionCount + action.optionCount) % action.optionCount;
    return { ...state, optionIndices: { ...state.optionIndices, [question.id]: optionIndex } };
  }
  if (action.type === "skip") {
    if (!question.optional) return state;
    const skippedIds = state.skippedIds.includes(question.id)
      ? state.skippedIds
      : [...state.skippedIds, question.id];
    return withResolvedAdvance(questions, {
      ...state,
      drafts: removeKey(state.drafts, question.id),
      answers: removeKey(state.answers, question.id),
      skippedIds,
    });
  }
  if (action.type === "selectOption") {
    if (
      !Number.isInteger(action.optionIndex) ||
      action.optionIndex < 0 ||
      action.optionIndex >= question.options.length
    ) return state;
    if (!question.multiSelect) {
      const option = question.options[action.optionIndex];
      if (option === undefined || option.label.trim().length === 0) return state;
      const answer: AskUserAnswer = {
        id: question.id,
        question: question.question,
        answer: option.label,
        wasCustom: false,
        index: action.optionIndex + 1,
      };
      return withResolvedAdvance(questions, {
        ...state,
        answers: { ...state.answers, [question.id]: answer },
        skippedIds: state.skippedIds.filter((id) => id !== question.id),
      });
    }
    const draft = draftFor(state, question.id);
    const optionIndices = draft.optionIndices.includes(action.optionIndex)
      ? draft.optionIndices.filter((index) => index !== action.optionIndex)
      : [...draft.optionIndices, action.optionIndex];
    return {
      ...state,
      drafts: { ...state.drafts, [question.id]: { ...draft, optionIndices } },
    };
  }
  if (action.type === "removeCustom") {
    if (!question.multiSelect) return state;
    const draft = draftFor(state, question.id);
    const { customText: _removed, ...withoutCustom } = draft;
    return {
      ...state,
      drafts: { ...state.drafts, [question.id]: withoutCustom },
    };
  }
  if (action.type === "submitCustom") {
    const text = action.text.trim();
    if (text.length === 0) return state;
    if (!question.multiSelect) {
      const answer: AskUserAnswer = {
        id: question.id,
        question: question.question,
        answer: text,
        wasCustom: true,
      };
      return withResolvedAdvance(questions, {
        ...state,
        answers: { ...state.answers, [question.id]: answer },
        skippedIds: state.skippedIds.filter((id) => id !== question.id),
      });
    }
    const draft = draftFor(state, question.id);
    return {
      ...state,
      drafts: { ...state.drafts, [question.id]: { ...draft, customText: text } },
    };
  }
  if (action.type === "commitMulti") {
    if (!question.multiSelect) return state;
    const selections = selectionFor(question, draftFor(state, question.id));
    if (selections.length === 0) return state;
    const answer: AskUserAnswer = {
      id: question.id,
      question: question.question,
      multiSelect: true,
      selections,
    };
    return withResolvedAdvance(questions, {
      ...state,
      answers: { ...state.answers, [question.id]: answer },
      skippedIds: state.skippedIds.filter((id) => id !== question.id),
    });
  }
  return state;
}
