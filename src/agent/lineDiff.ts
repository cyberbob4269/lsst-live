// Compact line-based diff for the write_file approval card (Phase 6 polish).
// Self-written, no dependency: LCS via dynamic programming over the differing
// middle of the two texts (common prefix/suffix is trimmed first, which keeps
// the DP matrix small for typical edits), then unchanged runs are collapsed
// to a gap marker keeping a few context lines around each change.

/** One renderable diff row. `gap` stands for `count` collapsed unchanged
 *  lines between two kept context lines. */
export type DiffRow =
  | { kind: "same" | "add" | "del"; text: string }
  | { kind: "gap"; count: number };

/** Safety bound on the DP matrix (old-lines × new-lines). Beyond this the
 *  middle is treated as a full replacement — the approval card row cap keeps
 *  the render small. */
const MAX_DP_CELLS = 4_000_000;

/** Longest-common-subsequence alignment of two line arrays as raw rows. */
function lcsRows(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_DP_CELLS) {
    return [
      ...a.map((text): DiffRow => ({ kind: "del", text })),
      ...b.map((text): DiffRow => ({ kind: "add", text })),
    ];
  }
  // dp[i][j] = LCS length of a[i..] and b[j..], row-major with width m+1.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      rows.push({ kind: "del", text: a[i] });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++] });
  while (j < m) rows.push({ kind: "add", text: b[j++] });
  return rows;
}

/** Raw (uncompacted) line diff of `oldText` → `newText`. */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // Trim the common prefix/suffix so the DP only sees the differing middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  return [
    ...a.slice(0, pre).map((text): DiffRow => ({ kind: "same", text })),
    ...lcsRows(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((text): DiffRow => ({ kind: "same", text })),
  ];
}

/** Collapse unchanged runs, keeping `context` lines around each change.
 *  Returns an empty array when the two texts are identical. */
export function compactDiff(rows: DiffRow[], context = 3): DiffRow[] {
  if (!rows.some((r) => r.kind === "add" || r.kind === "del")) return [];
  const out: DiffRow[] = [];
  const n = rows.length;
  let i = 0;
  while (i < n) {
    const row = rows[i];
    if (row.kind !== "same") {
      out.push(row);
      i++;
      continue;
    }
    let j = i;
    while (j < n && rows[j].kind === "same") j++;
    const runLen = j - i;
    const run = rows.slice(i, j);
    const leading = i === 0;
    const trailing = j === n;
    if (leading && runLen > context) {
      out.push({ kind: "gap", count: runLen - context }, ...run.slice(runLen - context));
    } else if (trailing && runLen > context) {
      out.push(...run.slice(0, context), { kind: "gap", count: runLen - context });
    } else if (!leading && !trailing && runLen > context * 2) {
      out.push(
        ...run.slice(0, context),
        { kind: "gap", count: runLen - context * 2 },
        ...run.slice(runLen - context)
      );
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}
