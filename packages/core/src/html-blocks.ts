/**
 * Turn the HTML of an imported post into NodePress blocks. It understands the markup WordPress
 * writes: paragraphs, headings, lists, quotes, code, images and the inline marks. Anything else
 * keeps its text (scripts, styles and iframes are dropped). The output uses the editor's block
 * shape (`core/paragraph` with `content` text nodes), which the server renders.
 *
 * WordPress "classic" content has no `<p>` tags: blank lines separate paragraphs and single
 * newlines are line breaks. That is handled too, and Gutenberg's `<!-- wp:... -->` comments are
 * ignored.
 */

export interface ImportedMark {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';
  href?: string;
}
export interface ImportedText {
  text: string;
  marks?: ImportedMark[];
}
export interface ImportedBlock {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ImportedText[];
  children?: ImportedBlock[];
}

const MAX_BLOCKS = 5000;
const INLINE_BREAKERS = new Set(['li', 'ul', 'ol', 'p', 'div']);
const MAX_DEPTH = 32;
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr']);
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
  'figure', 'figcaption', 'table', 'tr', 'section', 'article', 'hr',
]);
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–',
  mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      } catch {
        return '';
      }
    }
    return ENTITIES[body] ?? whole;
  });
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; tag: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: 'close'; tag: string };

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const pushText = (text: string): void => {
    if (text !== '') tokens.push({ kind: 'text', text });
  };
  while ((match = pattern.exec(html)) !== null) {
    pushText(html.slice(last, match.index));
    last = pattern.lastIndex;
    if (match[0].startsWith('<!--')) continue;
    const tag = (match[2] ?? '').toLowerCase();
    if (match[1] === '/') {
      tokens.push({ kind: 'close', tag });
      continue;
    }
    const rest = match[3] ?? '';
    const attrs: Record<string, string> = {};
    const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let a: RegExpExecArray | null;
    while ((a = attrPattern.exec(rest)) !== null) {
      attrs[(a[1] as string).toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    }
    tokens.push({ kind: 'open', tag, attrs, selfClosing: rest.trim().endsWith('/') || VOID.has(tag) });
    if (DROP.has(tag) && !rest.trim().endsWith('/')) {
      // Skip everything up to the matching close tag.
      const close = new RegExp(`</${tag}\\s*>`, 'ig');
      close.lastIndex = last;
      const end = close.exec(html);
      tokens.pop();
      last = end ? close.lastIndex : html.length;
      pattern.lastIndex = last;
    } else if (DROP.has(tag)) {
      tokens.pop();
    }
  }
  pushText(html.slice(last));
  return tokens;
}

/** Only web and mail links survive; `javascript:` and similar are dropped. */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const value = href.trim();
  if (/^(https?:|mailto:|tel:|\/|#|\?)/i.test(value)) return value;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value; // relative
  return undefined;
}

interface Frame {
  tag: string;
  marks: ImportedMark[];
}

/** Close the innermost open inline element named `tag`; false if none is open. */
function popTo(stack: Frame[], tag: string): boolean {
  for (let k = stack.length - 1; k > 0; k--) {
    if ((stack[k] as Frame).tag === tag) {
      stack.length = k;
      return true;
    }
  }
  return false;
}

function markFor(tag: string, attrs: Record<string, string>): ImportedMark | undefined {
  switch (tag) {
    case 'b':
    case 'strong':
      return { type: 'bold' };
    case 'i':
    case 'em':
    case 'cite':
      return { type: 'italic' };
    case 'u':
    case 'ins':
      return { type: 'underline' };
    case 's':
    case 'strike':
    case 'del':
      return { type: 'strike' };
    case 'code':
    case 'kbd':
      return { type: 'code' };
    case 'a': {
      const href = safeHref(attrs['href']);
      return href ? { type: 'link', href } : undefined;
    }
    default:
      return undefined;
  }
}

/** Collapse whitespace the way a browser shows it (outside `pre`). */
function collapse(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, ' ');
}

function sameMarks(a: ImportedMark[] | undefined, b: ImportedMark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

class Builder {
  blocks: ImportedBlock[] = [];
  #inline: ImportedText[] = [];

  addText(text: string, marks: ImportedMark[]): void {
    if (text === '') return;
    const prev = this.#inline[this.#inline.length - 1];
    if (prev && sameMarks(prev.marks, marks)) prev.text += text;
    else this.#inline.push({ text, ...(marks.length > 0 ? { marks: [...marks] } : {}) });
  }

  /** The pending inline text, trimmed at both ends; empty when it is only whitespace. */
  takeInline(preserve = false): ImportedText[] {
    const nodes = this.#inline;
    this.#inline = [];
    if (!preserve) {
      const first = nodes[0];
      if (first) first.text = first.text.replace(/^ +/, '');
      const last = nodes[nodes.length - 1];
      if (last) last.text = last.text.replace(/ +$/, '');
    }
    return nodes.filter((n) => n.text !== '');
  }

  hasInline(): boolean {
    return this.#inline.some((n) => n.text.trim() !== '');
  }
}

function paragraphsFromPlainText(text: string): ImportedBlock[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => ({ type: 'core/paragraph', content: [{ text: decode(p).replace(/\s*\n\s*/g, '\n') }] }));
}

/** Convert HTML (or WordPress classic text) to blocks. Never throws. */
export function htmlToBlocks(html: string): ImportedBlock[] {
  const source = typeof html === 'string' ? html : '';
  if (source.trim() === '') return [];
  // Classic content: no block-level tags at all, so blank lines make the paragraphs.
  if (!/<\s*(p|div|h[1-6]|ul|ol|blockquote|pre|figure|table)\b/i.test(source)) {
    const withBreaks = source.replace(/<br\s*\/?>/gi, '\n');
    if (!/<[a-zA-Z]/.test(withBreaks)) return paragraphsFromPlainText(withBreaks).slice(0, MAX_BLOCKS);
    // Inline markup inside classic paragraphs: convert each paragraph separately.
    return source
      .split(/\n{2,}/)
      .flatMap((part) => (part.trim() === '' ? [] : htmlToBlocks(`<p>${part.trim()}</p>`)))
      .slice(0, MAX_BLOCKS);
  }
  const tokens = tokenize(source);
  let position = 0;
  /** Images found inside a paragraph or heading; they become blocks right after it. */
  const deferred: ImportedBlock[] = [];

  function parseBlocks(stopTag: string | undefined, depth: number): ImportedBlock[] {
    const builder = new Builder();
    const flush = (): void => {
      if (builder.hasInline()) {
        builder.blocks.push({ type: 'core/paragraph', content: builder.takeInline() });
      } else builder.takeInline();
    };
    const stack: Frame[] = [{ tag: '', marks: [] }];
    const marks = (): ImportedMark[] => (stack[stack.length - 1] as Frame).marks;
    while (position < tokens.length && builder.blocks.length < MAX_BLOCKS) {
      const token = tokens[position] as Token;
      if (token.kind === 'text') {
        position++;
        builder.addText(collapse(decode(token.text)), marks());
        continue;
      }
      if (token.kind === 'close') {
        if (token.tag === stopTag) {
          position++;
          break;
        }
        position++;
        if (!popTo(stack, token.tag) && BLOCK_TAGS.has(token.tag)) flush();
        continue;
      }
      // Opening tag.
      position++;
      const { tag, attrs } = token;
      if (depth > MAX_DEPTH) continue;
      if (tag === 'br') {
        builder.addText('\n', marks());
      } else if (tag === 'img') {
        flush();
        const src = safeHref(attrs['src']);
        if (src) {
          builder.blocks.push({
            type: 'core/image',
            attrs: { src, alt: attrs['alt'] ?? '' },
          });
        }
      } else if (tag === 'hr') {
        flush();
      } else if (/^h[1-6]$/.test(tag)) {
        flush();
        const inner = parseInline(tag);
        if (inner.length > 0) {
          builder.blocks.push({ type: 'core/heading', attrs: { level: Number(tag[1]) }, content: inner });
        }
        builder.blocks.push(...deferred.splice(0));
      } else if (tag === 'p') {
        flush();
        const inner = parseInline('p');
        if (inner.length > 0) builder.blocks.push({ type: 'core/paragraph', content: inner });
        builder.blocks.push(...deferred.splice(0));
      } else if (tag === 'pre') {
        flush();
        const raw = collectRawText('pre');
        if (raw.trim() !== '') builder.blocks.push({ type: 'core/code', content: [{ text: raw.replace(/^\n+|\n+$/g, '') }] });
      } else if (tag === 'ul' || tag === 'ol') {
        flush();
        const items = parseList(tag, depth + 1);
        if (items.length > 0) {
          builder.blocks.push({
            type: 'core/list',
            attrs: { ordered: tag === 'ol' },
            children: items,
          });
        }
      } else if (tag === 'blockquote') {
        flush();
        const inner = parseBlocks('blockquote', depth + 1);
        const text = inner.flatMap((b) => b.content ?? []);
        if (text.length > 0) builder.blocks.push({ type: 'core/quote', content: joinParagraphs(text, inner) });
        else builder.blocks.push(...inner);
      } else if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'figure' || tag === 'figcaption') {
        flush();
        builder.blocks.push(...parseBlocks(tag, depth + 1));
      } else if (tag === 'li' || tag === 'table' || tag === 'tr' || tag === 'td' || tag === 'th') {
        flush();
      } else {
        const mark = markFor(tag, attrs);
        if (!token.selfClosing) stack.push({ tag, marks: mark ? [...marks(), mark] : marks() });
      }
    }
    flush();
    return builder.blocks;
  }

  /** Inline content up to the closing tag of `tag`. */
  function parseInline(tag: string, hoistImages = true): ImportedText[] {
    const builder = new Builder();
    const stack: Frame[] = [{ tag: '', marks: [] }];
    while (position < tokens.length) {
      const token = tokens[position] as Token;
      position++;
      if (token.kind === 'text') {
        builder.addText(collapse(decode(token.text)), (stack[stack.length - 1] as Frame).marks);
      } else if (token.kind === 'close') {
        if (popTo(stack, token.tag)) continue;
        if (token.tag === tag) break;
      } else if (token.tag === 'br') {
        builder.addText('\n', (stack[stack.length - 1] as Frame).marks);
      } else if (INLINE_BREAKERS.has(token.tag)) {
        builder.addText('\n', (stack[stack.length - 1] as Frame).marks);
        if (!token.selfClosing) stack.push({ tag: token.tag, marks: (stack[stack.length - 1] as Frame).marks });
      } else if (token.tag === 'img') {
        const src = safeHref(token.attrs['src']);
        const alt = token.attrs['alt'];
        if (hoistImages && src) deferred.push({ type: 'core/image', attrs: { src, alt: alt ?? '' } });
        else if (alt) builder.addText(alt, (stack[stack.length - 1] as Frame).marks);
      } else if (!token.selfClosing) {
        const mark = markFor(token.tag, token.attrs);
        const current = (stack[stack.length - 1] as Frame).marks;
        stack.push({ tag: token.tag, marks: mark ? [...current, mark] : current });
      }
    }
    return builder.takeInline();
  }

  function collectRawText(tag: string): string {
    let text = '';
    let nested = 0;
    while (position < tokens.length) {
      const token = tokens[position] as Token;
      position++;
      if (token.kind === 'text') text += decode(token.text);
      else if (token.kind === 'close') {
        if (token.tag === tag && nested === 0) break;
        if (token.tag === tag) nested--;
      } else if (token.tag === 'br') text += '\n';
      else if (token.tag === tag && !token.selfClosing) nested++;
    }
    return text;
  }

  function parseList(tag: string, depth: number): ImportedBlock[] {
    const items: ImportedBlock[] = [];
    while (position < tokens.length) {
      const token = tokens[position] as Token;
      if (token.kind === 'close' && token.tag === tag) {
        position++;
        break;
      }
      position++;
      if (token.kind === 'open' && token.tag === 'li') {
        const content = parseInlineUntilBlock();
        if (content.length > 0) items.push({ type: 'core/list-item', content });
      }
    }
    void depth;
    return items;
  }

  /** The text of one list item; nested lists are flattened into following items by the caller. */
  function parseInlineUntilBlock(): ImportedText[] {
    return parseInline('li', false);
  }

  function joinParagraphs(flat: ImportedText[], blocks: ImportedBlock[]): ImportedText[] {
    if (blocks.length <= 1) return flat;
    const out: ImportedText[] = [];
    blocks.forEach((b, index) => {
      if (index > 0) out.push({ text: '\n' });
      out.push(...(b.content ?? []));
    });
    return out;
  }

  return parseBlocks(undefined, 0).slice(0, MAX_BLOCKS);
}

/** Rewrite every `href` / `src` in blocks with `map`; return the (new) blocks. */
export function mapBlockUrls(
  blocks: readonly ImportedBlock[],
  map: (url: string, kind: 'link' | 'image') => string,
): ImportedBlock[] {
  return blocks.map((block) => {
    const next: ImportedBlock = { ...block };
    if (block.attrs && typeof block.attrs['src'] === 'string') {
      next.attrs = { ...block.attrs, src: map(block.attrs['src'], 'image') };
    }
    if (block.content) {
      next.content = block.content.map((node) =>
        node.marks
          ? {
              ...node,
              marks: node.marks.map((mark) =>
                mark.type === 'link' && mark.href !== undefined
                  ? { ...mark, href: map(mark.href, 'link') }
                  : mark,
              ),
            }
          : node,
      );
    }
    if (block.children) next.children = mapBlockUrls(block.children, map);
    return next;
  });
}
