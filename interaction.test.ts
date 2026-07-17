import assert from "node:assert/strict";
import test from "node:test";
import {
  createInteractionState,
  customTextFor,
  findNextUnresolvedIndex,
  firstMissingRequiredIndex,
  isOptionSelected,
  isQuestionAnswered,
  orderedAnswers,
  orderedSkippedIds,
  reduceInteraction,
  type InteractionQuestion,
  type InteractionState,
} from "./interaction.ts";

const question = (
  id: string,
  overrides: Partial<InteractionQuestion> = {},
): InteractionQuestion => ({
  id,
  question: `${id}?`,
  options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
  optional: false,
  multiSelect: false,
  ...overrides,
});

const reduce = (
  questions: ReadonlyArray<InteractionQuestion>,
  state: InteractionState,
  action: Parameters<typeof reduceInteraction>[2],
) => reduceInteraction(questions, state, action);

test("creates independent empty active state", () => {
  const first = createInteractionState();
  const second = createInteractionState();

  assert.deepEqual(first, {
    status: "active",
    current: 0,
    optionIndices: {},
    drafts: {},
    answers: {},
    skippedIds: [],
  });
  assert.notStrictEqual(first.optionIndices, second.optionIndices);
  assert.notStrictEqual(first.drafts, second.drafts);
  assert.notStrictEqual(first.answers, second.answers);
  assert.notStrictEqual(first.skippedIds, second.skippedIds);
});

test("moves each question cursor immutably with normalized wrapping", () => {
  const questions = [question("one"), question("two")];
  const initial = createInteractionState();
  const moved = reduce(questions, initial, { type: "moveCursor", delta: -4, optionCount: 3 });
  const second = reduce(questions, moved, { type: "navigate", index: 1 });
  const secondMoved = reduce(questions, second, { type: "moveCursor", delta: 5, optionCount: 3 });

  assert.deepEqual(initial.optionIndices, {});
  assert.equal(moved.optionIndices.one, 2);
  assert.equal(secondMoved.optionIndices.one, 2);
  assert.equal(secondMoved.optionIndices.two, 2);
  assert.strictEqual(reduce(questions, secondMoved, { type: "navigate", index: Number.NaN }), secondMoved);
});

test("commits a configured single selection with stable one-based option identity", () => {
  const questions = [question("target"), question("later", { optional: true })];
  const initial = createInteractionState();
  const selected = reduce(questions, initial, { type: "selectOption", optionIndex: 1 });

  assert.deepEqual(selected.answers.target, {
    id: "target",
    question: "target?",
    answer: "Beta",
    wasCustom: false,
    index: 2,
  });
  assert.equal(selected.current, 1);
  assert.equal(isQuestionAnswered(selected, "target"), true);
  assert.deepEqual(initial.answers, {});
});

test("commits trimmed custom single answers and rejects empty answers", () => {
  const questions = [question("target")];
  const initial = createInteractionState();

  assert.strictEqual(reduce(questions, initial, { type: "submitCustom", text: "  " }), initial);
  const answered = reduce(questions, initial, { type: "submitCustom", text: "  custom value  " });
  assert.deepEqual(answered.answers.target, {
    id: "target",
    question: "target?",
    answer: "custom value",
    wasCustom: true,
  });
  assert.equal(answered.status, "completed");
});

test("keeps multi-select drafts across navigation and commits canonical ordered selections", () => {
  const questions = [question("features", { multiSelect: true }), question("later")];
  let state = createInteractionState();
  state = reduce(questions, state, { type: "selectOption", optionIndex: 2 });
  state = reduce(questions, state, { type: "selectOption", optionIndex: 0 });
  state = reduce(questions, state, { type: "submitCustom", text: "  Delta  " });
  const drafted = state;
  state = reduce(questions, state, { type: "navigate", index: 1 });
  state = reduce(questions, state, { type: "navigate", index: 0 });

  assert.equal(isOptionSelected(state, "features", 0), true);
  assert.equal(isOptionSelected(state, "features", 2), true);
  assert.equal(customTextFor(state, "features"), "Delta");
  assert.deepEqual(state.drafts, drafted.drafts);
  assert.equal(isQuestionAnswered(state, "features"), false);

  const committed = reduce(questions, state, { type: "commitMulti" });
  assert.deepEqual(committed.answers.features, {
    id: "features",
    question: "features?",
    multiSelect: true,
    selections: [
      { answer: "Alpha", wasCustom: false, index: 1 },
      { answer: "Gamma", wasCustom: false, index: 3 },
      { answer: "Delta", wasCustom: true },
    ],
  });
  assert.equal(committed.current, 1);
});

test("toggles multi-select options without duplicates and never comma-joins canonical state", () => {
  const questions = [question("features", { multiSelect: true })];
  let state = createInteractionState();
  state = reduce(questions, state, { type: "selectOption", optionIndex: 1 });
  state = reduce(questions, state, { type: "selectOption", optionIndex: 1 });
  assert.deepEqual(state.drafts.features?.optionIndices, []);
  assert.strictEqual(reduce(questions, state, { type: "commitMulti" }), state);

  state = reduce(questions, state, { type: "selectOption", optionIndex: 0 });
  state = reduce(questions, state, { type: "submitCustom", text: "one, two" });
  state = reduce(questions, state, { type: "commitMulti" });
  const answer = state.answers.features;
  assert.equal(answer?.multiSelect, true);
  if (answer?.multiSelect === true) {
    assert.deepEqual(answer.selections, [
      { answer: "Alpha", wasCustom: false, index: 1 },
      { answer: "one, two", wasCustom: true },
    ]);
  }
});

test("stages edits separately from a committed multi-select answer", () => {
  const questions = [question("features", { multiSelect: true }), question("later")];
  let state = createInteractionState();
  state = reduce(questions, state, { type: "selectOption", optionIndex: 0 });
  state = reduce(questions, state, { type: "submitCustom", text: "original" });
  state = reduce(questions, state, { type: "commitMulti" });
  const committed = state.answers.features;

  state = reduce(questions, state, { type: "navigate", index: 0 });
  state = reduce(questions, state, { type: "selectOption", optionIndex: 1 });
  state = reduce(questions, state, { type: "removeCustom" });

  assert.strictEqual(state.answers.features, committed);
  assert.deepEqual(state.drafts.features, { optionIndices: [0, 1] });
  assert.equal(isQuestionAnswered(state, "features"), true);

  state = reduce(questions, state, { type: "commitMulti" });
  assert.deepEqual(state.answers.features, {
    id: "features",
    question: "features?",
    multiSelect: true,
    selections: [
      { answer: "Alpha", wasCustom: false, index: 1 },
      { answer: "Beta", wasCustom: false, index: 2 },
    ],
  });
});

test("makes optional skip explicit and exclusive", () => {
  const questions = [question("optional", { optional: true, multiSelect: true }), question("later")];
  let state = createInteractionState();
  state = reduce(questions, state, { type: "selectOption", optionIndex: 0 });
  state = reduce(questions, state, { type: "commitMulti" });
  state = reduce(questions, state, { type: "navigate", index: 0 });
  state = reduce(questions, state, { type: "skip" });

  assert.deepEqual(state.skippedIds, ["optional"]);
  assert.equal(state.answers.optional, undefined);
  assert.equal(state.drafts.optional, undefined);

  state = reduce(questions, state, { type: "navigate", index: 0 });
  state = reduce(questions, state, { type: "selectOption", optionIndex: 1 });
  state = reduce(questions, state, { type: "submitCustom", text: "draft" });
  assert.deepEqual(state.skippedIds, ["optional"]);
  assert.deepEqual(state.drafts.optional, { optionIndices: [1], customText: "draft" });

  const staged = state;
  state = reduce(questions, state, { type: "navigate", index: 1 });
  const dismissed = reduce(questions, state, { type: "dismiss" });
  assert.deepEqual(orderedAnswers(questions, dismissed), []);
  assert.deepEqual(orderedSkippedIds(questions, dismissed), ["optional"]);

  state = reduce(questions, staged, { type: "commitMulti" });
  assert.deepEqual(state.skippedIds, []);
  assert.equal(state.answers.optional?.multiSelect, true);

  const requiredState = createInteractionState();
  assert.strictEqual(
    reduce([question("required")], requiredState, { type: "skip" }),
    requiredState,
  );
});

test("required gating accepts only committed non-empty answers", () => {
  const questions = [question("required"), question("optional", { optional: true })];
  const emptySingle: InteractionState = {
    ...createInteractionState(),
    answers: {
      required: {
        id: "required",
        question: "required?",
        answer: "   ",
        wasCustom: true,
      },
    },
  };
  const emptyMulti: InteractionState = {
    ...createInteractionState(),
    answers: {
      required: {
        id: "required",
        question: "required?",
        multiSelect: true,
        selections: [{ answer: "", wasCustom: true }],
      },
    },
  };
  const draftOnly = reduce(
    [question("required", { multiSelect: true })],
    createInteractionState(),
    { type: "selectOption", optionIndex: 0 },
  );

  assert.equal(firstMissingRequiredIndex(questions, emptySingle), 0);
  assert.equal(firstMissingRequiredIndex(questions, emptyMulti), 0);
  assert.equal(firstMissingRequiredIndex([question("required", { multiSelect: true })], draftOnly), 0);
  assert.strictEqual(reduce(questions, emptySingle, { type: "complete" }), emptySingle);
});

test("orders answers and explicit skips by question order", () => {
  const questions = [question("first"), question("second", { optional: true }), question("third")];
  let state = createInteractionState();
  state = reduce(questions, state, { type: "navigate", index: 2 });
  state = reduce(questions, state, { type: "selectOption", optionIndex: 2 });
  state = reduce(questions, state, { type: "navigate", index: 1 });
  state = reduce(questions, state, { type: "skip" });
  state = reduce(questions, state, { type: "navigate", index: 0 });
  state = reduce(questions, state, { type: "selectOption", optionIndex: 0 });

  assert.deepEqual(orderedAnswers(questions, state).map((answer) => answer.id), ["first", "third"]);
  assert.deepEqual(orderedSkippedIds(questions, state), ["second"]);
  assert.equal(findNextUnresolvedIndex(questions, state, 0), undefined);
});

test("terminal transitions are idempotent and cancellation discards intent", () => {
  const questions = [question("first"), question("optional", { optional: true })];
  let active = reduce(questions, createInteractionState(), { type: "selectOption", optionIndex: 0 });
  const dismissed = reduce(questions, active, { type: "dismiss" });
  assert.strictEqual(reduce(questions, dismissed, { type: "cancel" }), dismissed);
  assert.strictEqual(reduce(questions, dismissed, { type: "navigate", index: 0 }), dismissed);

  const cancelled = reduce(questions, active, { type: "cancel" });
  assert.deepEqual(cancelled, { ...createInteractionState(), status: "cancelled" });
  assert.strictEqual(reduce(questions, cancelled, { type: "cancel" }), cancelled);

  active = reduce(questions, active, { type: "navigate", index: 1 });
  active = reduce(questions, active, { type: "skip" });
  const completed = reduce(questions, active, { type: "complete" });
  assert.equal(completed.status, "completed");
  assert.strictEqual(reduce(questions, completed, { type: "dismiss" }), completed);
});
