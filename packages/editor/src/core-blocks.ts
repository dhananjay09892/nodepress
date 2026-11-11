import { escapeHtml, safeUrl } from './html.js';
import { plainText, renderInline } from './inline.js';
import { BlockRegistry } from './registry.js';
import type { Block, BlockDefinition } from './types.js';

function attr<T>(block: Block, key: string, check: (v: unknown) => v is T): T | undefined {
  const value = block.attrs?.[key];
  return check(value) ? value : undefined;
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 10000;

function requireChildren(block: Block, childType: string, min: number, max: number): void {
  const children = block.children ?? [];
  if (children.length < min || children.length > max) {
    throw new Error(`${block.type} needs between ${min} and ${max} children`);
  }
  for (const child of children) {
    if (child.type !== childType) throw new Error(`${block.type} children must be ${childType}`);
  }
}

const paragraph: BlockDefinition = {
  name: 'core/paragraph',
  title: 'Paragraph',
  render: (block) => `<p>${renderInline(block.content)}</p>`,
};

const heading: BlockDefinition = {
  name: 'core/heading',
  title: 'Heading',
  validate(block) {
    const level = block.attrs?.['level'];
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) {
      throw new Error('heading level must be an integer from 1 to 6');
    }
    return block;
  },
  render(block) {
    const level = attr(block, 'level', isPositiveInt) ?? 2;
    const tag = `h${Math.min(Math.max(level, 1), 6)}`;
    return `<${tag}>${renderInline(block.content)}</${tag}>`;
  },
};

const image: BlockDefinition = {
  name: 'core/image',
  title: 'Image',
  validate(block) {
    if (!attr(block, 'src', isString) && !attr(block, 'mediaId', isString)) {
      throw new Error('image needs a src or a mediaId');
    }
    if (typeof block.attrs?.['alt'] !== 'string') {
      throw new Error('image needs alt text (use an empty string for decorative images)');
    }
    return block;
  },
  render(block, ctx) {
    const mediaId = attr(block, 'mediaId', isString);
    const src = safeUrl(
      (mediaId && ctx.resolveMediaUrl?.(mediaId)) || attr(block, 'src', isString),
    );
    if (!src) return '';
    const alt = attr(block, 'alt', isString) ?? '';
    const width = attr(block, 'width', isPositiveInt);
    const height = attr(block, 'height', isPositiveInt);
    const dims = `${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}`;
    const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"${dims}>`;
    const caption = attr(block, 'caption', isString);
    return caption
      ? `<figure>${img}<figcaption>${escapeHtml(caption)}</figcaption></figure>`
      : `<figure>${img}</figure>`;
  },
};

const listItem: BlockDefinition = {
  name: 'core/list-item',
  title: 'List item',
  render: (block, ctx) =>
    `<li>${renderInline(block.content)}${ctx.renderChildren(block.children)}</li>`,
};

const list: BlockDefinition = {
  name: 'core/list',
  title: 'List',
  validate(block) {
    requireChildren(block, 'core/list-item', 1, 1000);
    return block;
  },
  render(block, ctx) {
    const tag = attr(block, 'ordered', isBoolean) ? 'ol' : 'ul';
    return `<${tag}>${ctx.renderChildren(block.children)}</${tag}>`;
  },
};

const quote: BlockDefinition = {
  name: 'core/quote',
  title: 'Quote',
  render(block) {
    const citation = attr(block, 'citation', isString);
    const cite = citation ? `<cite>${escapeHtml(citation)}</cite>` : '';
    return `<blockquote><p>${renderInline(block.content)}</p>${cite}</blockquote>`;
  },
};

const code: BlockDefinition = {
  name: 'core/code',
  title: 'Code',
  render(block) {
    const language = attr(block, 'language', isString);
    // Only a conservative token is allowed in the class name.
    const cls =
      language && /^[a-z0-9+#-]{1,32}$/i.test(language)
        ? ` class="language-${language.toLowerCase()}"`
        : '';
    return `<pre><code${cls}>${escapeHtml(plainText(block.content))}</code></pre>`;
  },
};

const EMBED_PROVIDERS: { host: RegExp; embed(url: URL): string | undefined }[] = [
  {
    host: /^(www\.)?youtube\.com$/,
    embed: (url) => {
      const id = url.pathname === '/watch' ? url.searchParams.get('v') : null;
      return id && /^[\w-]{6,20}$/.test(id)
        ? `https://www.youtube-nocookie.com/embed/${id}`
        : undefined;
    },
  },
  {
    host: /^youtu\.be$/,
    embed: (url) => {
      const id = url.pathname.slice(1);
      return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : undefined;
    },
  },
  {
    host: /^(www\.)?vimeo\.com$/,
    embed: (url) => {
      const id = url.pathname.slice(1);
      return /^\d{3,12}$/.test(id) ? `https://player.vimeo.com/video/${id}` : undefined;
    },
  },
];

const embed: BlockDefinition = {
  name: 'core/embed',
  title: 'Embed',
  validate(block) {
    let url: URL;
    try {
      url = new URL(String(block.attrs?.['url']));
    } catch {
      throw new Error('embed needs a valid url');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('embed url must be http(s)');
    return block;
  },
  render(block) {
    const raw = safeUrl(attr(block, 'url', isString));
    if (!raw) return '';
    let iframeSrc: string | undefined;
    try {
      const url = new URL(raw);
      iframeSrc = EMBED_PROVIDERS.find((p) => p.host.test(url.hostname))?.embed(url);
    } catch {
      return '';
    }
    // Only allowlisted providers become iframes; anything else is a plain link.
    if (iframeSrc) {
      return `<figure class="np-embed"><iframe src="${escapeHtml(iframeSrc)}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="Embedded video"></iframe></figure>`;
    }
    return `<figure class="np-embed"><a href="${escapeHtml(raw)}" rel="noopener noreferrer">${escapeHtml(raw)}</a></figure>`;
  },
};

const column: BlockDefinition = {
  name: 'core/column',
  title: 'Column',
  render: (block, ctx) => `<div class="np-column">${ctx.renderChildren(block.children)}</div>`,
};

const columns: BlockDefinition = {
  name: 'core/columns',
  title: 'Columns',
  validate(block) {
    requireChildren(block, 'core/column', 2, 6);
    return block;
  },
  render: (block, ctx) =>
    `<div class="np-columns np-columns-${block.children?.length ?? 0}">${ctx.renderChildren(block.children)}</div>`,
};

const button: BlockDefinition = {
  name: 'core/button',
  title: 'Button',
  validate(block) {
    if (!attr(block, 'text', isString)) throw new Error('button needs text');
    if (!safeUrl(block.attrs?.['href'])) throw new Error('button needs a safe href');
    return block;
  },
  render(block) {
    const href = safeUrl(attr(block, 'href', isString));
    const text = attr(block, 'text', isString);
    if (!href || !text) return '';
    const style = attr(block, 'style', isString) === 'outline' ? 'outline' : 'fill';
    return `<p class="np-button-wrap"><a class="np-button np-button-${style}" href="${escapeHtml(href)}">${escapeHtml(text)}</a></p>`;
  },
};

export const coreBlocks: readonly BlockDefinition[] = [
  paragraph,
  heading,
  image,
  list,
  listItem,
  quote,
  code,
  embed,
  columns,
  column,
  button,
];

export function createBlockRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const block of coreBlocks) registry.register(block);
  return registry;
}
