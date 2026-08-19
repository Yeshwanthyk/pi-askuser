import assert from "node:assert/strict";
import test from "node:test";
import { TUI_KEYBINDINGS, KeybindingsManager, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createAskUserTui, type TuiInteractionResult, type TuiParams } from "./tui.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeComponent(params: TuiParams, rows = 24, onDone: (result: TuiInteractionResult) => void = () => {}) {
  let renders = 0;
  const tui = {
    terminal: { rows },
    requestRender: () => { renders += 1; },
  } as unknown as TUI;
  const component = createAskUserTui({
    params,
    questions: params.questions,
    tui,
    theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    signal: new AbortController().signal,
    done: onDone,
  });
  return { component, tui, get renders() { return renders; } };
}

const multi = (id = "features") => ({
  id,
  question: "Which features?",
  options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
  optional: false,
  multiSelect: true,
});

function output(component: ReturnType<typeof createAskUserTui>, width = 80): string {
  return component.render(width).join("\n");
}

test("shows required multi-select feedback and numeric shortcuts without numbering actions", () => {
  const { component } = makeComponent({ questions: [multi()] });
  let screen = output(component);
  assert.match(screen, /1 \[ \] Alpha/);
  assert.match(screen, /2 \[ \] Beta/);
  assert.match(screen, /Actions/);
  assert.doesNotMatch(screen, /4 .*Done selecting/);

  component.handleInput("2");
  screen = output(component);
  assert.match(screen, /2 \[x\] Beta/);

  component.handleInput("2");
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\r");
  assert.match(output(component), /Select at least one option before Done/);
});

test("previews saved custom text and exposes navigation and dismissal keys", () => {
  const params: TuiParams = { questions: [multi(), { ...multi("later"), multiSelect: false }] };
  const { component } = makeComponent(params);
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\r");
  component.handleInput("saved custom answer");
  component.handleInput("\r");
  assert.match(output(component), /saved: saved custom answer/);

  const screen = output(component);
  assert.match(screen, /Shift\+Tab\/Left back/);
  assert.match(screen, /Esc\/Ctrl\+C Dismiss/);
  assert.match(screen, /Space\/1–3 Toggle/);
});

test("keeps machine IDs out of the human-facing review", () => {
  const params: TuiParams = { questions: [multi(), { ...multi("later"), multiSelect: false }] };
  const { component } = makeComponent(params);
  component.handleInput("1");
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\r");
  component.handleInput("1");
  const screen = output(component);
  assert.match(screen, /Review answers/);
  assert.doesNotMatch(screen, /\[features\]|\[later\]/);
  assert.match(screen, /Enter Submit/);
});

test("drives navigation, batch movement, escape dismissal, and short-height rendering", () => {
  let result: TuiInteractionResult | undefined;
  const { component, tui } = makeComponent({ questions: [multi(), { ...multi("later"), multiSelect: false }] }, 4, (value) => {
    result = value;
  });

  component.handleInput("\u001b[B");
  component.handleInput("\u001b[A");
  component.handleInput("\t");
  component.handleInput("\u001b[Z");
  component.handleInput("\u001b");
  assert.equal(result?.status, "dismissed");

  const terminal = tui.terminal as unknown as { rows: number };
  terminal.rows = 1;
  component.invalidate();
  assert.ok(component.render(40).length <= 1);
});

test("keeps an empty required multi-select active while showing Done feedback", () => {
  let result: TuiInteractionResult | undefined;
  const { component } = makeComponent({ questions: [multi()] }, 24, (value) => {
    result = value;
  });

  for (let index = 0; index < 4; index++) component.handleInput("\u001b[B");
  component.handleInput("\r");

  assert.equal(result, undefined);
  assert.match(output(component), /Done selecting.*Select at least one option before Done/);
});

test("renders numeric multi-select markers only for configured options", () => {
  const { component } = makeComponent({ questions: [multi()] });
  const initial = output(component);
  assert.match(initial, /1 \[ \] Alpha/);
  assert.match(initial, /2 \[ \] Beta/);
  assert.match(initial, /3 \[ \] Gamma/);
  assert.doesNotMatch(initial, /4 .*Done selecting/);

  component.handleInput("3");
  assert.match(output(component), /3 \[x\] Gamma/);
  component.handleInput("3");
  assert.match(output(component), /3 \[ \] Gamma/);
});

test("keeps saved custom text visible after leaving and reopening a question", () => {
  const params: TuiParams = { questions: [multi(), { ...multi("later"), multiSelect: false }] };
  const { component } = makeComponent(params);

  for (let index = 0; index < 3; index++) component.handleInput("\u001b[B");
  component.handleInput("\r");
  component.handleInput("saved custom answer");
  component.handleInput("\r");
  assert.match(output(component), /saved: saved custom answer/);

  component.handleInput("\t");
  component.handleInput("\u001b[Z");
  assert.match(output(component), /saved: saved custom answer/);

  component.handleInput("\r");
  assert.match(output(component), /Your answer:/);
  assert.match(output(component), /saved custom answer/);
});

test("copies configured movement, confirmation, navigation, and dismissal keys into the footer", () => {
  const { component } = makeComponent({ questions: [multi(), { ...multi("later"), multiSelect: false }] });
  const screen = output(component);

  assert.match(screen, /Up\/Down Move/);
  assert.match(screen, /Space\/1–3 Toggle/);
  assert.match(screen, /Enter Confirm \(Done commits\)/);
  assert.match(screen, /Tab\/Right next/);
  assert.match(screen, /Shift\+Tab\/Left back/);
  assert.match(screen, /Esc\/Ctrl\+C Dismiss/);
});

test("renders a human-readable review with answers and optional state", () => {
  const params: TuiParams = {
    questions: [
      { ...multi(), header: "Features" },
      { ...multi("later"), header: "Later", multiSelect: false },
      { ...multi("optional"), header: "Optional", multiSelect: false, optional: true },
    ],
  };
  const { component } = makeComponent(params);

  component.handleInput("1");
  for (let index = 0; index < 4; index++) component.handleInput("\u001b[B");
  component.handleInput("\r");
  component.handleInput("2");
  component.handleInput("\t");

  const screen = output(component);
  assert.match(screen, /Review answers/);
  assert.match(screen, /1\. Features — 1\. Alpha/);
  assert.match(screen, /2\. Later — 2\. Beta/);
  assert.match(screen, /3\. Optional \(optional\) — not answered \(optional\)/);
  assert.doesNotMatch(screen, /\[features\]|\[later\]|\[optional\]/);
});

test("groups custom, completion, and skip rows below configured answers", () => {
  const { component } = makeComponent({ questions: [{ ...multi(), optional: true }] });
  const lines = output(component).split("\n");
  const actions = lines.findIndex((line) => line.includes("Actions"));

  assert.ok(actions >= 0);
  assert.ok(lines.findIndex((line) => line.includes("Alpha")) < actions);
  assert.ok(lines.findIndex((line) => line.includes("Write my own answer")) > actions);
  assert.ok(lines.findIndex((line) => line.includes("Done selecting")) > actions);
  assert.ok(lines.findIndex((line) => line.includes("Skip this question")) > actions);
  assert.equal(lines.slice(actions + 1).some((line) => /\d+ \[[ x]\]/.test(line)), false);
});

test("keeps every rendered line safe across narrow widths and terminal heights", () => {
  const { component, tui } = makeComponent({
    context: "A deliberately long context that must wrap without overflowing the terminal.",
    questions: [{
      ...multi(),
      question: "A deliberately long question that must remain renderable.",
      options: [
        { label: "Alpha with a long label", description: "A long description that also wraps." },
        { label: "Beta with a long label" },
        { label: "Gamma with a long label" },
      ],
    }],
  }, 24);
  const terminal = tui.terminal as unknown as { rows: number };

  for (const rows of [0, 1, 2, 4, 8, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    terminal.rows = rows;
    for (const width of [0, 1, 2, 8, 40]) {
      assert.doesNotThrow(() => {
        const lines = component.render(width);
        const expectedRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
        assert.ok(lines.length <= expectedRows);
        assert.ok(lines.every((line) => visibleWidth(line) <= Math.max(1, width)));
      }, `rows=${rows}, width=${width}`);
    }
  }
});
