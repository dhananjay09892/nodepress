import type { Block } from '@nodepress/editor';

export type DiffKind = 'same' | 'added' | 'removed';
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** The text of a block tree, one line per text-bearing block (lists and columns included). */
export function blocksToLines(blocks: readonly Block[]): string[] {
  const lines: string[] = [];
  const visit = (block: Block) => {
    if (block.content !== undefined) {
      const text = block.content.map((node) => node.text).join('');
      if (text.trim() !== '') lines.push(text);
    }
    for (const child of block.children ?? []) visit(child);
  };
  for (const block of blocks) visit(block);
  return lines;
}

/** Beyond this many line pairs the exact diff is skipped (it would be slow and unreadable). */
const MAX_CELLS = 250_000;

/**
 * A line diff from `before` to `after` (longest common subsequence). Lines only in `before` are
 * `removed`, lines only in `after` are `added`. Very large inputs fall back to "everything removed,
 * everything added" instead of freezing the page.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_CELLS) {
    return [
      ...before.map((text) => ({ kind: 'removed' as const, text })),
      ...after.map((text) => ({ kind: 'added' as const, text })),
    ];
  }
  // lcs[i][j]: length of the common subsequence of before[i..] and after[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: before[i++]! });
    } else {
      out.push({ kind: 'added', text: after[j++]! });
    }
  }
  while (i < n) out.push({ kind: 'removed', text: before[i++]! });
  while (j < m) out.push({ kind: 'added', text: after[j++]! });
  return out;
}

export interface RevisionDiff {
  /** The title as one or two lines: unchanged, or the old one removed and the new one added. */
  title: DiffLine[];
  text: DiffLine[];
  /** True when neither the title nor the text differs. */
  identical: boolean;
}

/** What changed from a saved version (`revision`) to what is in the form now (`current`). */
export function diffRevision(
  revision: { title: string; body: readonly Block[] },
  current: { title: string; body: readonly Block[] },
): RevisionDiff {
  const title = diffLines([revision.title], [current.title]);
  const text = diffLines(blocksToLines(revision.body), blocksToLines(current.body));
  return {
    title,
    text,
    identical: [...title, ...text].every((line) => line.kind === 'same'),
  };
}
