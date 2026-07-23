import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
  AskUserParams,
  buildAskUserDetails,
  InteractionQueue,
  InteractionQueueRegistry,
  normalizeAskUserArguments,
  parseAskUserArguments,
  renderAskUserCall,
  runDialogInteraction,
} from "./index.ts";
import { buildAskUserResultMessage } from "./prompt.ts";

const options = [{ label: "Yes" }, { label: "No", description: "Not now" }];
const question = (id: string, optional?: boolean) => ({
  id,
  question: `${id}?`,
  options,
  ...(optional === undefined ? {} : { optional }),
});
const plainTheme: Pick<Theme, "fg" | "bold"> = {
  fg: (_color, text) => text,
  bold: (text) => text,
};
const renderCall = (args: unknown, argsComplete: boolean) =>
  renderAskUserCall(args, plainTheme, argsComplete)
    .render(500)
    .map((line) => line.trimEnd())
    .join("\n");

test("renders incomplete partial arguments as a neutral call header", () => {
  assert.equal(renderCall({ questions: [{ id: "deploy" }] }, false), "ask_user");
});

test("renders completed malformed arguments as invalid", () => {
  assert.equal(
    renderCall({ questions: [{ id: "deploy" }] }, true),
    "ask_user invalid arguments",
  );
});

test("preserves completed valid single and multi-question summaries", () => {
  assert.equal(
    renderCall({ questions: [question("deploy")] }, true),
    "ask_user deploy?\n  1. Yes  2. No",
  );
  assert.equal(
    renderCall({ questions: [{ ...question("deploy"), header: "Deployment" }] }, true),
    "ask_user Deployment\n  1. Yes  2. No",
  );
  assert.equal(
    renderCall({ questions: [{ ...question("region"), header: "Region" }, question("tier")] }, true),
    "ask_user 2 questions (Region, tier)",
  );
});

test("normalizes Opus decoration while leaving valid Sol arguments unchanged", () => {
  const sol = { questions: [question("deploy")] };
  assert.strictEqual(normalizeAskUserArguments(sol), sol);

  const opus = {
    questions: [{
      ...question("roles"),
      options: [
        { label: "Simple", aside: "Least overlap" },
        { label: "Advanced", description: "Keep all integrations", aside: "More control" },
      ],
    }],
  };
  assert.equal(Check(AskUserParams, opus), false);
  const normalized = normalizeAskUserArguments(opus);
  assert.deepEqual(normalized, {
    questions: [{
      ...question("roles"),
      options: [
        { label: "Simple", description: "Least overlap" },
        { label: "Advanced", description: "Keep all integrations" },
      ],
    }],
  });
  assert.equal(Check(AskUserParams, normalized), true);
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

test("validates per-question headers, multi-select, optional, and strict fields", () => {
  const extended = {
    questions: [{ ...question("notes", true), header: "Release notes", multiSelect: true }],
  };
  assert.deepEqual(parseAskUserArguments(extended), extended);
  assert.equal(Check(AskUserParams, extended), true);
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
  for (const header of ["", "   ", "line one\nline two", "x".repeat(25)]) {
    const args = { questions: [{ ...question("q"), header }] };
    assert.equal(Check(AskUserParams, args), false, `schema accepted ${JSON.stringify(header)}`);
    assert.throws(() => parseAskUserArguments(args), /header/);
  }
  const topLevelHeader = { header: "Batch", questions: [question("q")] };
  assert.equal(Check(AskUserParams, topLevelHeader), false);
  assert.throws(() => parseAskUserArguments(topLevelHeader), /unsupported field/);
});

test("keeps schema and parser whitespace rules aligned for every string field", () => {
  const cases: Array<{
    name: string;
    args: unknown;
    accepted: boolean;
  }> = [
    { name: "id", args: { questions: [{ ...question("q"), id: "   " }] }, accepted: false },
    { name: "question", args: { questions: [{ ...question("q"), question: "   " }] }, accepted: false },
    { name: "header", args: { questions: [{ ...question("q"), header: "   " }] }, accepted: false },
    {
      name: "option label",
      args: { questions: [{ ...question("q"), options: [{ label: "   " }, options[1]] }] },
      accepted: false,
    },
    {
      name: "option description",
      args: { questions: [{ ...question("q"), options: [{ label: "Yes", description: "   " }, options[1]] }] },
      accepted: true,
    },
    { name: "question context", args: { questions: [{ ...question("q"), context: "   " }] }, accepted: false },
    { name: "shared context", args: { context: "   ", questions: [question("q")] }, accepted: false },
  ];

  for (const { name, args, accepted } of cases) {
    assert.equal(Check(AskUserParams, args), accepted, `${name} schema result`);
    if (accepted) assert.doesNotThrow(() => parseAskUserArguments(args), name);
    else assert.throws(() => parseAskUserArguments(args), Error, name);
  }
});

test("counts header limits by Unicode code points", () => {
  const accepted = { questions: [{ ...question("q"), header: "🙂".repeat(24) }] };
  const rejected = { questions: [{ ...question("q"), header: "🙂".repeat(25) }] };

  assert.equal(Check(AskUserParams, accepted), true);
  assert.doesNotThrow(() => parseAskUserArguments(accepted));
  assert.equal(Check(AskUserParams, rejected), false);
  assert.throws(() => parseAskUserArguments(rejected), /at most 24 characters/);
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

test("formats multi-select results with configured and custom provenance", () => {
  assert.equal(
    buildAskUserResultMessage({
      kind: "completed",
      questions: [{ id: "targets", question: "Targets?", optional: false }],
      answers: [{
        id: "targets",
        question: "Targets?",
        multiSelect: true,
        selections: [
          { answer: "Linux", wasCustom: false, index: 1 },
          { answer: "FreeBSD", wasCustom: true },
        ],
      }],
      skippedOptionalQuestionIds: [],
    }),
    "[targets] Targets?: user selected option 1: Linux; user wrote: FreeBSD",
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

test("details include headers, multi-select flags, skips, and distinct statuses", () => {
  const input = parseAskUserArguments({
    questions: [
      { ...question("proceed"), header: "Proceed", multiSelect: true },
      question("notes", true),
    ],
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
    assert.deepEqual(details.questions.map(({ header }) => header), ["Proceed", undefined]);
    assert.deepEqual(details.questions.map(({ multiSelect }) => multiSelect), [true, false]);
    assert.deepEqual(details.questions.map(({ optional }) => optional), [false, true]);
    const scrubbed = status === "cancelled" || status === "no-ui";
    assert.deepEqual(details.answers, scrubbed ? [] : [answer]);
    assert.deepEqual(details.skippedOptionalQuestionIds, scrubbed ? [] : ["notes"]);
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

test("serializes interactions and lets an aborted waiter leave the queue", async () => {
  const queue = new InteractionQueue();
  const releaseFirst = await queue.acquire();
  assert.ok(releaseFirst);

  let secondAcquired = false;
  const second = queue.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false);

  const abortController = new AbortController();
  const aborted = queue.acquire(abortController.signal);
  abortController.abort();
  assert.equal(await aborted, undefined);

  releaseFirst();
  const releaseSecond = await second;
  assert.ok(releaseSecond);
  releaseSecond();

  const releaseThird = await queue.acquire();
  assert.ok(releaseThird);
  releaseThird();
});

test("isolates interaction queues by UI session", async () => {
  const registry = new InteractionQueueRegistry();
  const firstUi = {};
  const secondUi = {};
  const releaseFirst = await registry.for(firstUi).acquire();
  assert.ok(releaseFirst);

  let sameUiAcquired = false;
  const sameUi = registry.for(firstUi).acquire().then((release) => {
    sameUiAcquired = true;
    return release;
  });
  const releaseSecondUi = await registry.for(secondUi).acquire();

  assert.ok(releaseSecondUi);
  assert.equal(sameUiAcquired, false);
  releaseSecondUi();
  releaseFirst();
  const releaseSameUi = await sameUi;
  assert.ok(releaseSameUi);
  releaseSameUi();
});

test("dialog fallback answers single- and multi-select questions headlessly", async () => {
  const input = parseAskUserArguments({
    questions: [
      question("first"),
      { id: "second", question: "second?", options, multiSelect: true },
      question("third", true),
    ],
  });
  const questions = input.questions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options,
    optional: q.optional ?? false,
    multiSelect: q.multiSelect ?? false,
  }));
  const selects: Array<(choices: string[]) => string | undefined> = [
    () => "Yes",
    (choices) => choices[1], // toggle "No — Not now"
    () => "✏️ Other…",
    () => "✓ Done",
    () => "⏭ Skip (optional)",
  ];
  const ui = {
    select: async (_title: string, choices: string[]) => selects.shift()?.(choices),
    input: async () => "custom text",
  };
  const result = await runDialogInteraction(ui, input, questions, undefined);
  assert.equal(result.status, "completed");
  assert.equal(result.answers.length, 2);
  assert.deepEqual(result.answers[0], { id: "first", question: "first?", answer: "Yes", wasCustom: false, index: 0 });
  const multi = result.answers[1];
  assert.equal(multi.multiSelect, true);
  if (multi.multiSelect === true) {
    assert.deepEqual(
      multi.selections.map((s: { answer: string; wasCustom: boolean }) => [s.answer, s.wasCustom]),
      [["No", false], ["custom text", true]],
    );
  }
  assert.deepEqual(result.skippedOptionalQuestionIds, ["third"]);
});

test("dialog fallback treats a cancelled dialog as dismissed with partial answers", async () => {
  const input = parseAskUserArguments({ questions: [question("a"), question("b")] });
  const questions = input.questions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options,
    optional: q.optional ?? false,
    multiSelect: q.multiSelect ?? false,
  }));
  const selects = [() => "Yes", () => undefined];
  const ui = {
    select: async () => selects.shift()?.(),
    input: async () => undefined,
  };
  const result = await runDialogInteraction(ui, input, questions, undefined);
  assert.equal(result.status, "dismissed");
  assert.equal(result.answers.length, 1);
});
