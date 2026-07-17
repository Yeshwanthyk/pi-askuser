export interface LineRange {
  start: number;
  end: number;
}

export interface ViewportInput {
  rows: number;
  header: string[];
  body: string[];
  footer: string[];
  anchor?: LineRange;
  offset?: number;
}

export interface ViewportResult {
  lines: string[];
  bodyStart: number;
  bodyEnd: number;
  hiddenAbove: number;
  hiddenBelow: number;
}

export function markerLineRange(
  lines: ReadonlyArray<string>,
  marker: string,
  offset = 0,
): LineRange | undefined {
  const index = lines.findIndex((line) => line.includes(marker));
  return index < 0 ? undefined : { start: offset + index, end: offset + index + 1 };
}

interface BodyWindow {
  start: number;
  end: number;
  showAbove: boolean;
  showBelow: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function integer(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** Returns the fullest body window beginning at start, including indicator rows. */
function windowAt(bodyLength: number, capacity: number, start: number): BodyWindow {
  const showAbove = start > 0 && capacity >= 2;
  const rowsAfterAbove = capacity - (showAbove ? 1 : 0);
  const remainingLines = bodyLength - start;
  const showBelow = remainingLines > rowsAfterAbove && rowsAfterAbove >= 2;
  const contentRows = Math.max(1, rowsAfterAbove - (showBelow ? 1 : 0));

  return {
    start,
    end: Math.min(bodyLength, start + contentRows),
    showAbove,
    showBelow,
  };
}

function maximumStart(bodyLength: number, capacity: number): number {
  if (bodyLength <= capacity) return 0;
  // At the bottom, an above indicator consumes one row whenever one is available.
  return capacity >= 2 ? bodyLength - capacity + 1 : bodyLength - 1;
}

function anchoredWindow(
  bodyLength: number,
  capacity: number,
  anchor: LineRange | undefined,
): BodyWindow {
  const rawStart = integer(anchor?.start ?? 0, 0);
  const anchorStart = clamp(rawStart, 0, bodyLength - 1);
  const rawEnd = integer(anchor?.end ?? anchorStart + 1, anchorStart + 1);
  const anchorEnd = clamp(Math.max(anchorStart + 1, rawEnd), anchorStart + 1, bodyLength);
  const maxStart = maximumStart(bodyLength, capacity);
  const preferredStart = clamp(anchorEnd - capacity, 0, maxStart);

  let best: BodyWindow | undefined;
  for (let start = 0; start <= maxStart; start++) {
    const candidate = windowAt(bodyLength, capacity, start);
    if (candidate.start > anchorStart || candidate.end < anchorEnd) continue;

    const candidateLines = candidate.end - candidate.start;
    const bestLines = best === undefined ? -1 : best.end - best.start;
    if (
      candidateLines > bestLines ||
      (candidateLines === bestLines &&
        Math.abs(candidate.start - preferredStart) < Math.abs((best?.start ?? 0) - preferredStart))
    ) {
      best = candidate;
    }
  }

  // An oversized anchor cannot fit whole; retain its beginning (or the clamped bottom window).
  return best ?? windowAt(bodyLength, capacity, clamp(anchorStart, 0, maxStart));
}

function overflowLine(direction: "above" | "below", count: number): string {
  const arrow = direction === "above" ? "↑" : "↓";
  return `${arrow} ${count} more line${count === 1 ? "" : "s"}`;
}

/** Fits pre-wrapped lines to a terminal while keeping the requested body range visible. */
export function fitViewport(input: ViewportInput): ViewportResult {
  const rows = Math.max(0, integer(input.rows, 0));
  if (rows === 0) {
    return {
      lines: [],
      bodyStart: 0,
      bodyEnd: 0,
      hiddenAbove: 0,
      hiddenBelow: input.body.length,
    };
  }

  // Keep one body row at tiny heights. Header lines win over footer lines otherwise,
  // while a truncated footer retains its final (usually border) lines.
  const minimumBodyRows = input.body.length > 0 ? 1 : 0;
  const chromeCapacity = Math.max(0, rows - minimumBodyRows);
  const header = input.header.slice(0, chromeCapacity);
  const footerCapacity = Math.max(0, chromeCapacity - header.length);
  const footer = input.footer.slice(Math.max(0, input.footer.length - footerCapacity));
  const capacity = rows - header.length - footer.length;

  if (capacity === 0 || input.body.length === 0) {
    return {
      lines: [...header, ...footer],
      bodyStart: 0,
      bodyEnd: 0,
      hiddenAbove: 0,
      hiddenBelow: input.body.length,
    };
  }

  const maxStart = maximumStart(input.body.length, capacity);
  const window = input.offset === undefined
    ? anchoredWindow(input.body.length, capacity, input.anchor)
    : windowAt(
      input.body.length,
      capacity,
      clamp(integer(input.offset, 0), 0, maxStart),
    );
  const hiddenAbove = window.start;
  const hiddenBelow = input.body.length - window.end;
  const body = [
    ...(window.showAbove ? [overflowLine("above", hiddenAbove)] : []),
    ...input.body.slice(window.start, window.end),
    ...(window.showBelow ? [overflowLine("below", hiddenBelow)] : []),
  ];

  return {
    lines: [...header, ...body, ...footer],
    bodyStart: window.start,
    bodyEnd: window.end,
    hiddenAbove,
    hiddenBelow,
  };
}
