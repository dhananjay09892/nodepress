/** Builds the hooks reference from the `ActionMap` / `FilterMap` declarations in the source. */

export interface HookEntry {
  kind: 'action' | 'filter';
  name: string;
  /** The declared type, whitespace collapsed. */
  signature: string;
  /** The JSDoc text above the entry, if any. */
  description: string;
  /** Source file, relative to the repository root. */
  file: string;
}

const INTERFACES: Array<{ name: string; kind: HookEntry['kind'] }> = [
  { name: 'ActionMap', kind: 'action' },
  { name: 'FilterMap', kind: 'filter' },
];

/** Index just after the `}` that closes the `{` at `open`; strings and comments are skipped. */
function closingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = source.indexOf(ch, i + 1);
      if (end === -1) return source.length;
      i = end;
    } else if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      if (end === -1) return source.length;
      i = end;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return source.length;
      i = end + 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

function cleanDoc(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*\/?\*+\/?\s?/, '').trimEnd())
    .join('\n')
    .trim()
    .replace(/\n{2,}/g, '\n\n')
    .replace(/(?<!\n)\n(?!\n)/g, ' ');
}

/** The hook entries declared in one source file, in declaration order. */
export function extractHooks(source: string, file: string): HookEntry[] {
  const entries: HookEntry[] = [];
  for (const { name, kind } of INTERFACES) {
    const header = new RegExp(`interface ${name}\\s*\\{`, 'g');
    let match: RegExpExecArray | null;
    while ((match = header.exec(source))) {
      const open = match.index + match[0].length - 1;
      const body = source.slice(open + 1, closingBrace(source, open) - 1);
      entries.push(...parseBody(body, kind, file));
    }
  }
  return entries;
}

function parseBody(body: string, kind: HookEntry['kind'], file: string): HookEntry[] {
  const out: HookEntry[] = [];
  let doc = '';
  let i = 0;
  while (i < body.length) {
    const rest = body.slice(i);
    const comment = /^\s*\/\*\*([\s\S]*?)\*\//.exec(rest);
    if (comment) {
      doc = cleanDoc(comment[1] ?? '');
      i += comment[0].length;
      continue;
    }
    const lineComment = /^\s*\/\/[^\n]*/.exec(rest);
    if (lineComment) {
      i += lineComment[0].length;
      continue;
    }
    const key = /^\s*(?:'([^']+)'|"([^"]+)")\s*:/.exec(rest);
    if (!key) {
      i += rest.search(/\S/) === -1 ? rest.length : Math.max(1, rest.search(/\S/) + 1);
      continue;
    }
    // The type runs to the first `;` outside brackets.
    let j = i + key[0].length;
    let depth = 0;
    for (; j < body.length; j++) {
      const ch = body[j];
      if (ch === "'" || ch === '"' || ch === '`') {
        j = body.indexOf(ch, j + 1);
        if (j === -1) break;
      } else if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
      else if ((ch === ';' || ch === ',') && depth === 0) break;
    }
    const end = j === -1 ? body.length : j;
    out.push({
      kind,
      name: key[1] ?? key[2] ?? '',
      signature: body.slice(i + key[0].length, end).replace(/\s+/g, ' ').trim(),
      description: doc,
      file,
    });
    doc = '';
    i = end + 1;
  }
  return out;
}

function table(entries: HookEntry[]): string {
  return entries
    .map((entry) => {
      const lines = [`### \`${entry.name}\``, ''];
      if (entry.description) lines.push(entry.description, '');
      lines.push('```ts', entry.signature, '```', '', `Declared in \`${entry.file}\`.`, '');
      return lines.join('\n');
    })
    .join('\n');
}

/** The reference page (Markdown with Starlight front matter). */
export function renderHooksReference(entries: HookEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const actions = sorted.filter((entry) => entry.kind === 'action');
  const filters = sorted.filter((entry) => entry.kind === 'filter');
  return [
    '---',
    'title: Hooks reference',
    'description: Every action and filter NodePress core and the bundled plugins declare.',
    '---',
    '',
    'This page is generated from the `ActionMap` and `FilterMap` declarations in the source, so it always matches the code.',
    '',
    'An **action** announces that something happened; listeners receive the arguments shown. A **filter** passes a `value` through every listener; each returns the new value, and `context` is read-only extra information.',
    '',
    `## Actions (${actions.length})`,
    '',
    table(actions),
    `## Filters (${filters.length})`,
    '',
    table(filters),
  ].join('\n');
}
