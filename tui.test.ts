import assert from "node:assert/strict";
import test from "node:test";
import { TUI_KEYBINDINGS, KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
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
