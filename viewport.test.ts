import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { fitViewport, markerLineRange, type ViewportInput } from "./viewport.ts";

const body = (length: number) => Array.from({ length }, (_, index) => `body-${index}`);
const fit = (overrides: Partial<ViewportInput> = {}) => fitViewport({
  rows: 10,
  header: [],
  body: body(5),
  footer: [],
  ...overrides,
});

test("clamps zero, negative, fractional, and non-finite terminal heights", () => {
  for (const rows of [0, -4, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(fit({ rows }), {
      lines: [],
      bodyStart: 0,
      bodyEnd: 0,
      hiddenAbove: 0,
      hiddenBelow: 5,
    });
  }

  assert.deepEqual(fit({ rows: 1.9 }).lines, ["body-0"]);
});

test("uses the only row for anchored body content without overflowing it", () => {
  const result = fit({ rows: 1, anchor: { start: 3, end: 4 } });
  assert.deepEqual(result, {
    lines: ["body-3"],
    bodyStart: 3,
    bodyEnd: 4,
    hiddenAbove: 3,
    hiddenBelow: 1,
  });
});

test("preserves width-neutral pre-wrapped strings exactly", () => {
  const header = ["\u001b[31m界 header\u001b[0m"];
  const content = ["\u001b[32m🙂 body\u001b[0m"];
  const footer = ["\u001b[2mfooter\u001b[0m"];
  assert.deepEqual(
    fit({ rows: 3, header, body: content, footer }).lines,
    [...header, ...content, ...footer],
  );
});

test("keeps header prefixes and footer suffixes while reserving a body row", () => {
  const result = fit({
    rows: 5,
    header: ["h0", "h1"],
    body: body(8),
    footer: ["f0", "f1", "f2"],
    anchor: { start: 4, end: 5 },
  });
  assert.deepEqual(result.lines, ["h0", "h1", "body-4", "f1", "f2"]);
  assert.equal(result.lines.length, 5);
});

test("shows and accounts for overflow indicators", () => {
  const result = fit({ rows: 4, body: body(6), offset: 2 });
  assert.deepEqual(result, {
    lines: ["↑ 2 more lines", "body-2", "body-3", "↓ 2 more lines"],
    bodyStart: 2,
    bodyEnd: 4,
    hiddenAbove: 2,
    hiddenBelow: 2,
  });
  assert.equal(
    result.lines.length,
    (result.hiddenAbove > 0 ? 1 : 0) +
      (result.bodyEnd - result.bodyStart) +
      (result.hiddenBelow > 0 ? 1 : 0),
  );
});

test("omits indicators that cannot physically fit beside content", () => {
  assert.deepEqual(fit({ rows: 1, body: body(4), offset: 2 }).lines, ["body-2"]);
  assert.deepEqual(fit({ rows: 2, body: body(4), offset: 1 }).lines, [
    "↑ 1 more line",
    "body-1",
  ]);
});

test("honors explicit review offsets and clamps both ends", () => {
  assert.equal(fit({ rows: 4, body: body(7), offset: -10 }).bodyStart, 0);
  assert.deepEqual(fit({ rows: 4, body: body(7), offset: 99 }), {
    lines: ["↑ 4 more lines", "body-4", "body-5", "body-6"],
    bodyStart: 4,
    bodyEnd: 7,
    hiddenAbove: 4,
    hiddenBelow: 0,
  });
});

test("reclamps a saved review offset after a resize and fills the larger viewport", () => {
  const small = fit({ rows: 4, body: body(10), offset: 6 });
  assert.equal(small.bodyStart, 6);

  const resized = fit({ rows: 8, body: body(10), offset: small.bodyStart });
  assert.deepEqual(resized.lines, [
    "↑ 3 more lines",
    "body-3",
    "body-4",
    "body-5",
    "body-6",
    "body-7",
    "body-8",
    "body-9",
  ]);
  assert.equal(resized.bodyStart, 3);
  assert.equal(resized.bodyEnd, 10);
});

test("keeps a multi-line anchor visible whenever its exact range and indicators fit", () => {
  for (let length = 1; length <= 8; length++) {
    for (let rows = 1; rows <= 8; rows++) {
      for (let start = 0; start < length; start++) {
        for (let end = start + 1; end <= length; end++) {
          const requiredRows = end - start + (start > 0 ? 1 : 0) + (end < length ? 1 : 0);
          if (requiredRows > rows) continue;

          const result = fit({ rows, body: body(length), anchor: { start, end } });
          assert.ok(
            result.bodyStart <= start && result.bodyEnd >= end,
            `length=${length}, rows=${rows}, anchor=[${start}, ${end}), viewport=[${result.bodyStart}, ${result.bodyEnd})`,
          );
        }
      }
    }
  }
});

test("keeps the focused row of a multiline editor visible at short heights", () => {
  const tui = {
    terminal: { rows: 4 },
    requestRender: () => undefined,
  } as unknown as TUI;
  const editorTheme: EditorTheme = {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
  const editor = new Editor(tui, editorTheme);
  editor.setText("first line\nsecond line\nfocused line");
  editor.focused = true;
  const editorLines = editor.render(40);
  const body = ["Your answer:", ...editorLines];
  const anchor = markerLineRange(editorLines, CURSOR_MARKER, 1);

  assert.notEqual(anchor, undefined);
  for (const rows of [1, 2, 3, 4]) {
    const result = fit({
      rows,
      header: ["Question"],
      body,
      footer: ["Instructions", "────────"],
      anchor,
    });
    assert.equal(
      result.lines.some((line) => line.includes(CURSOR_MARKER)),
      true,
      `cursor clipped at ${rows} rows`,
    );
  }
});

test("shows the beginning of an oversized anchor and remains within height", () => {
  const result = fit({ rows: 4, body: body(8), anchor: { start: 2, end: 7 } });
  assert.deepEqual(result, {
    lines: ["↑ 2 more lines", "body-2", "body-3", "↓ 4 more lines"],
    bodyStart: 2,
    bodyEnd: 4,
    hiddenAbove: 2,
    hiddenBelow: 4,
  });
});

test("never exceeds rows across body, chrome, anchor, and offset combinations", () => {
  for (let rows = 0; rows <= 10; rows++) {
    for (let length = 0; length <= 10; length++) {
      for (const offset of [undefined, -1, 0, 2, 20]) {
        const result = fit({
          rows,
          header: ["h0", "h1", "h2"],
          body: body(length),
          footer: ["f0", "f1", "f2"],
          anchor: { start: Math.max(0, length - 3), end: length },
          ...(offset === undefined ? {} : { offset }),
        });
        assert.ok(result.lines.length <= rows, `rows=${rows}, length=${length}, offset=${offset}`);
        assert.equal(result.hiddenAbove, result.bodyStart);
        assert.equal(result.hiddenBelow, length - result.bodyEnd);
      }
    }
  }
});
