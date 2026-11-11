/**
 * The NodePress block envelope. This is what is stored in `content.body` and
 * returned by the API. It is deliberately independent of the editor engine
 * (see docs/adr/0001-editor.md): the admin converts to and from it at the
 * editor boundary, and the server renders it without a DOM.
 */

export const BLOCK_DOCUMENT_VERSION = 1;

export type MarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';

export interface Mark {
  type: MarkType;
  /** Only used by `link` marks. */
  href?: string;
}

export interface TextNode {
  text: string;
  marks?: Mark[];
}

export type BlockAttrs = Record<string, unknown>;

export interface Block {
  type: string;
  attrs?: BlockAttrs;
  /** Inline text for text-bearing blocks (paragraph, heading, quote, code, list item). */
  content?: TextNode[];
  /** Nested blocks (list items, columns and their contents). */
  children?: Block[];
}

export interface BlockDocument {
  version: typeof BLOCK_DOCUMENT_VERSION;
  blocks: Block[];
}

export interface RenderContext {
  /** Render the given blocks (used by container blocks such as columns). */
  renderChildren(blocks: readonly Block[] | undefined): string;
  /** Resolve a media id to a public URL, if the caller can. */
  resolveMediaUrl?: ((mediaId: string) => string | undefined) | undefined;
}

export interface BlockDefinition {
  /** Unique name, e.g. `core/paragraph`. Plugins use their own prefix. */
  name: string;
  title: string;
  /**
   * Validate and normalise a block. Throw an Error with a readable message
   * for invalid input; return the cleaned block otherwise.
   */
  validate?(block: Block): Block;
  /** Return trusted HTML. Everything user-controlled must be escaped. */
  render(block: Block, ctx: RenderContext): string;
}

export interface RenderOptions {
  resolveMediaUrl?: (mediaId: string) => string | undefined;
  /** Called when a block fails to render or is unknown. The page still renders. */
  onError?: (error: Error, block: Block) => void;
}

export interface ValidationIssue {
  /** Path such as `blocks[2].children[0]`. */
  path: string;
  message: string;
}
