export { BlockRegistry } from './registry.js';
export { coreBlocks, createBlockRegistry } from './core-blocks.js';
export { renderBlocks, validateDocument } from './render.js';
export { renderInline, plainText } from './inline.js';
export { escapeHtml, safeUrl } from './html.js';
export {
  blockFromTiptap,
  blockToTiptap,
  envelopeToTiptap,
  tiptapToEnvelope,
} from './tiptap-json.js';
export type { TiptapDoc, TiptapMark, TiptapNode } from './tiptap-json.js';
export { BLOCK_DOCUMENT_VERSION } from './types.js';
export type {
  Block,
  BlockAttrs,
  BlockDefinition,
  BlockDocument,
  Mark,
  MarkType,
  RenderContext,
  RenderOptions,
  TextNode,
  ValidationIssue,
} from './types.js';
