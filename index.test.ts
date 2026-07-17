import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  AskUserParams,
  buildAskUserDetails,
  findNextUnansweredIndex,
  firstMissingRequiredIndex,
  parseAskUserArguments,
  savedCustomText,
  savedOptionIndex,
} from "./index.ts";
import { buildAskUserResultMessage } from "./prompt.ts";

const options = [{ label: "Yes" }, { label: "No", description: "Not now" }];
const question = (id: string, optional?: boolean) => ({
  id,
  question: `${id}?`,
  options,
  ...(optional === undefined ? {} : { optional }),
});

test("accepts only the strict current input shape", () => {
  const input = {
    context: "Choose deployment defaults.",
    questions: [
      question("region"),
      { ...question("tier", true), context: "Cost differs by tier." },
    ],
  };
  assert.deepEqual(parseAskUserArguments(input), input);
  assert.equal(Check(AskUserParams, input), true);

  const unsupportedTopLevelShape = {
    question: "Proceed?",
    options,
    context: "The check passed.",
  };
  assert.throws(() => parseAskUserArguments(unsupportedTopLevelShape), /unsupported field/);
  assert.equal(Check(AskUserParams, unsupportedTopLevelShape), false);
});

test("accepts 10 questions and rejects 11", () => {
  const ten = { questions: Array.from({ length: 10 }, (_, index) => question(`q${index}`)) };
  assert.equal(parseAskUserArguments(ten).questions.length, 10);
  assert.equal(Check(AskUserParams, ten), true);

  const eleven = { questions: Array.from({ length: 11 }, (_, index) => question(`q${index}`)) };
  assert.throws(() => parseAskUserArguments(eleven), /1 to 10/);
  assert.equal(Check(AskUserParams, eleven), false);
});

test("validates optional and other strict question fields", () => {
  assert.equal(Check(AskUserParams, { questions: [question("notes", true)] }), true);
  assert.equal(Check(AskUserParams, { questions: [question("notes", false)] }), true);
  const optionalSchema = AskUserParams.properties.questions.items.properties.optional;
  assert.equal("default" in optionalSchema ? optionalSchema.default : undefined, false);
  assert.match(
    "description" in optionalSchema && typeof optionalSchema.description === "string"
      ? optionalSchema.description
      : "",
    /skip/,
  );
  assert.equal(
    Check(AskUserParams, { questions: [{ ...question("notes"), optional: "yes" }] }),
    false,
  );
  assert.throws(
    () => parseAskUserArguments({ questions: [{ ...question("notes"), optional: "yes" }] }),
    /optional must be a boolean/,
  );
  assert.throws(
    () => parseAskUserArguments({ questions: [question("same"), question("same")] }),
    /unique ids/,
  );
  assert.throws(
    () => parseAskUserArguments({ questions: [{ ...question("q"), extra: true }] }),
    /unsupported field/,
  );
});

test("formats completion with answered, skipped, and untouched optional questions", () => {
  assert.equal(
    buildAskUserResultMessage({
      kind: "completed",
      questions: [
        { id: "region", question: "Region?", optional: false },
        { id: "tier", question: "Tier?", optional: true },
        { id: "notes", question: "Notes?", optional: true },
      ],
      answers: [
        {
          id: "region",
          question: "Region?",
          answer: "EU",
          wasCustom: false,
          index: 2,
        },
      ],
      skippedOptionalQuestionIds: ["tier"],
    }),
    [
      "[region] Region?: user selected option 2: EU",
      "[tier] Tier?: skipped (optional)",
      "[notes] Notes?: not answered (optional)",
    ].join("\n"),
  );
});

test("formats dismissal with all partial rows and no inference", () => {
  assert.equal(
    buildAskUserResultMessage({
      kind: "dismissed",
      questions: [
        { id: "region", question: "Region?", optional: false },
        { id: "notes", question: "Notes?", optional: true },
        { id: "tier", question: "Tier?", optional: false },
        { id: "telemetry", question: "Telemetry?", optional: true },
      ],
      answers: [
        {
          id: "region",
          question: "Region?",
          answer: "EU",
          wasCustom: false,
          index: 1,
        },
        {
          id: "notes",
          question: "Notes?",
          answer: "Use the existing account",
          wasCustom: true,
        },
      ],
      skippedOptionalQuestionIds: ["telemetry"],
    }),
    [
      "User dismissed the question UI. Preserve every collected answer; unanswered required and optional values are missing and must not be inferred.",
      "[region] Region?: user selected option 1: EU",
      "[notes] Notes?: user wrote: Use the existing account",
      "[tier] Tier?: not answered (required)",
      "[telemetry] Telemetry?: skipped (optional)",
    ].join("\n"),
  );
});

test("required gating ignores unanswered optional questions", () => {
  const questions = [question("required"), question("optional", true), question("later")];
  assert.equal(firstMissingRequiredIndex(questions, new Set()), 0);
  assert.equal(firstMissingRequiredIndex(questions, new Set(["required"])), 2);
  assert.equal(
    firstMissingRequiredIndex(questions, new Set(["required", "later"])),
    undefined,
  );
});

test("restores saved model and custom option cursors", () => {
  assert.equal(
    savedOptionIndex(3, {
      id: "region",
      question: "Region?",
      answer: "EU",
      wasCustom: false,
      index: 2,
    }),
    1,
  );
  const custom = {
    id: "notes",
    question: "Notes?",
    answer: "Keep the current layout",
    wasCustom: true,
  };
  assert.equal(savedOptionIndex(3, custom), 3);
  assert.equal(savedCustomText(custom), "Keep the current layout");
  assert.equal(savedOptionIndex(3, undefined), 0);
  assert.equal(savedCustomText(undefined), "");
});

test("finds the next unresolved question cyclically", () => {
  const ids = ["first", "second", "third"];
  assert.equal(findNextUnansweredIndex(ids, new Set(["second"]), 2), 0);
  assert.equal(findNextUnansweredIndex(ids, new Set(["first", "third"]), 2), 1);
  assert.equal(findNextUnansweredIndex(ids, new Set(ids), 1), undefined);
});

test("details include optional flags, skips, and distinct statuses", () => {
  const input = parseAskUserArguments({
    questions: [question("proceed"), question("notes", true)],
  });
  const answer = {
    id: "proceed",
    question: "proceed?",
    answer: "Yes",
    wasCustom: false,
    index: 1,
  };

  for (const status of ["completed", "dismissed", "cancelled", "no-ui"] as const) {
    const details = buildAskUserDetails(input, [answer], ["notes"], status);
    assert.deepEqual(details.questions.map(({ optional }) => optional), [false, true]);
    assert.deepEqual(details.skippedOptionalQuestionIds, ["notes"]);
    assert.equal(details.status, status);
    assert.equal(details.cancelled, status === "cancelled");
  }
});

test("cancellation does not imply user intent", () => {
  assert.equal(
    buildAskUserResultMessage({ kind: "cancelled" }),
    "The ask_user interaction was cancelled or aborted. Do not infer user intent from cancellation.",
  );
});
