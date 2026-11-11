import type { BlockRegistry } from './registry.js';
import type {
  Block,
  BlockDocument,
  RenderContext,
  RenderOptions,
  ValidationIssue,
} from './types.js';
import { BLOCK_DOCUMENT_VERSION } from './types.js';

const MAX_DEPTH = 8;

/**
 * Render a block document to HTML with no DOM. A block that is unknown or
 * throws is skipped (and reported through `onError`): a bad plugin block
 * must never take a page down.
 */
export function renderBlocks(
  doc: BlockDocument | readonly Block[],
  registry: BlockRegistry,
  options: RenderOptions = {},
): string {
  const blocks = Array.isArray(doc) ? doc : (doc as BlockDocument).blocks;
  return renderList(blocks as readonly Block[], registry, options, 0);
}

function renderList(
  blocks: readonly Block[] | undefined,
  registry: BlockRegistry,
  options: RenderOptions,
  depth: number,
): string {
  if (!blocks) return '';
  if (depth > MAX_DEPTH) return '';
  const ctx: RenderContext = {
    renderChildren: (children) => renderList(children, registry, options, depth + 1),
    resolveMediaUrl: options.resolveMediaUrl,
  };
  let out = '';
  for (const block of blocks) {
    try {
      const def = registry.get(block.type);
      if (!def) throw new Error(`Unknown block type "${block.type}"`);
      out += def.render(block, ctx);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)), block);
    }
  }
  return out;
}

export function validateDocument(input: unknown, registry: BlockRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const doc = input as Partial<BlockDocument> | null;
  if (!doc || typeof doc !== 'object' || doc.version !== BLOCK_DOCUMENT_VERSION || !Array.isArray(doc.blocks)) {
    return [{ path: '', message: `expected { version: ${BLOCK_DOCUMENT_VERSION}, blocks: [...] }` }];
  }
  doc.blocks.forEach((block, i) => validateBlock(block, `blocks[${i}]`, registry, issues, 0));
  return issues;
}

function validateBlock(
  block: unknown,
  path: string,
  registry: BlockRegistry,
  issues: ValidationIssue[],
  depth: number,
): void {
  if (!block || typeof block !== 'object' || typeof (block as Block).type !== 'string') {
    issues.push({ path, message: 'block must be an object with a type' });
    return;
  }
  if (depth > MAX_DEPTH) {
    issues.push({ path, message: `blocks are nested deeper than ${MAX_DEPTH} levels` });
    return;
  }
  const b = block as Block;
  const def = registry.get(b.type);
  if (!def) {
    issues.push({ path, message: `unknown block type "${b.type}"` });
    return;
  }
  if (b.content !== undefined && !(Array.isArray(b.content) && b.content.every((n) => typeof n?.text === 'string'))) {
    issues.push({ path, message: 'content must be an array of { text } nodes' });
  }
  if (b.children !== undefined && !Array.isArray(b.children)) {
    issues.push({ path, message: 'children must be an array' });
    return;
  }
  try {
    def.validate?.(b);
  } catch (error) {
    issues.push({ path, message: error instanceof Error ? error.message : String(error) });
  }
  b.children?.forEach((child, i) => validateBlock(child, `${path}.children[${i}]`, registry, issues, depth + 1));
}
