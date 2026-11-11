import { BlockEditor } from '@nodepress/editor/react';
import { BLOCK_DOCUMENT_VERSION, type BlockDocument } from '@nodepress/editor';
import { useState } from 'react';

const EMPTY: BlockDocument = { version: BLOCK_DOCUMENT_VERSION, blocks: [] };

/**
 * Temporary screen at /editor-preview, used to try the block editor before the post edit
 * screen (N18) exists. It is not linked from the sidebar and saves nothing.
 */
export function EditorPreview() {
  const [document, setDocument] = useState<BlockDocument>(EMPTY);
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Editor preview</h1>
      <p className="mt-2 mb-4 text-slate-700">
        Temporary screen for trying the block editor. Nothing is saved.
      </p>
      <BlockEditor value={EMPTY} onChange={setDocument} label="Preview content" />
      <h2 className="mt-6 text-lg font-semibold text-slate-900">Block JSON</h2>
      <pre
        data-testid="block-json"
        className="mt-2 overflow-x-auto rounded border border-slate-300 bg-slate-50 p-3 text-xs"
      >
        {JSON.stringify(document, null, 2)}
      </pre>
    </section>
  );
}
