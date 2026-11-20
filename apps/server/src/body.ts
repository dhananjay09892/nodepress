import { createBlockRegistry, renderBlocks, type Block, type TextNode } from '@nodepress/editor';
import type { Content, ContentBlock, HookRegistry, Logger } from '@nodepress/core';

const MAX_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTextNodes(block: Record<string, unknown>): TextNode[] | undefined {
  // The admin editor stores `content` text nodes; the generic stored shape uses a plain `text`.
  if (Array.isArray(block['content'])) {
    const nodes = block['content'].filter(
      (node): node is TextNode => isRecord(node) && typeof node['text'] === 'string',
    );
    return nodes.length > 0 ? nodes : undefined;
  }
  const text = block['text'];
  return typeof text === 'string' && text !== '' ? [{ text }] : undefined;
}

/**
 * Convert one stored block (`ContentBlock` with `text`, or the editor's `Block` with `content`
 * text nodes) to the editor shape the renderer takes. Anything that is not a block is dropped.
 * A bare type such as `paragraph` is read as `core/paragraph`.
 */
export function toEditorBlock(input: ContentBlock | unknown, depth = 0): Block | undefined {
  if (depth > MAX_DEPTH || !isRecord(input)) return undefined;
  const type = input['type'];
  if (typeof type !== 'string' || type === '') return undefined;
  const block: Block = { type: type.includes('/') ? type : `core/${type}` };
  if (isRecord(input['attrs'])) block.attrs = input['attrs'];
  const content = toTextNodes(input);
  if (content) block.content = content;
  if (Array.isArray(input['children'])) {
    const children = input['children']
      .map((child) => toEditorBlock(child, depth + 1))
      .filter((child): child is Block => child !== undefined);
    if (children.length > 0) block.children = children;
  }
  return block;
}

export function toEditorBlocks(body: unknown): Block[] {
  if (!Array.isArray(body)) return [];
  return body.map((b) => toEditorBlock(b)).filter((b): b is Block => b !== undefined);
}

export interface BodyRendererOptions {
  hooks: HookRegistry;
  logger: Logger;
  /** Resolve a media id to a public URL. */
  resolveMediaUrl?: (mediaId: string) => string | undefined;
}

/**
 * Build the `renderBody` the theme system calls: blocks to HTML with the core block registry, then
 * the `post:content` filter. Unknown or failing blocks are skipped and logged; the page still renders.
 */
export function createBodyRenderer(options: BodyRendererOptions) {
  const registry = createBlockRegistry();
  return async (content: Content): Promise<string> => {
    const html = renderBlocks(toEditorBlocks(content.body), registry, {
      ...(options.resolveMediaUrl ? { resolveMediaUrl: options.resolveMediaUrl } : {}),
      onError: (error, block) =>
        options.logger.warn(`Skipped block "${block.type}" in #${content.id}: ${error.message}`),
    });
    return String(await options.hooks.applyFilters('post:content', html));
  };
}
