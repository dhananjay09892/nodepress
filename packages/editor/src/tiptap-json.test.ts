import { describe, expect, it } from 'vitest';
import { createBlockRegistry } from './core-blocks.js';
import { renderBlocks, validateDocument } from './render.js';
import { blockFromTiptap, blockToTiptap, envelopeToTiptap, tiptapToEnvelope } from './tiptap-json.js';
import type { Block, BlockDocument } from './types.js';

const doc = (...blocks: Block[]): BlockDocument => ({ version: 1, blocks });

const fixtures: Record<string, Block> = {
  paragraph: {
    type: 'core/paragraph',
    content: [
      { text: 'Hello ' },
      { text: 'bold', marks: [{ type: 'bold' }, { type: 'italic' }] },
      { text: ' link', marks: [{ type: 'link', href: 'https://example.com/a' }] },
      { text: ' x', marks: [{ type: 'underline' }, { type: 'strike' }, { type: 'code' }] },
    ],
  },
  'empty paragraph': { type: 'core/paragraph' },
  heading: { type: 'core/heading', attrs: { level: 3 }, content: [{ text: 'Title' }] },
  image: {
    type: 'core/image',
    attrs: { src: '/uploads/a.png', alt: 'An image', width: 640, height: 480, caption: 'Cap' },
  },
  'image from media library': { type: 'core/image', attrs: { mediaId: '7', alt: '' } },
  list: {
    type: 'core/list',
    attrs: { ordered: false },
    children: [
      { type: 'core/list-item', content: [{ text: 'one' }] },
      {
        type: 'core/list-item',
        content: [{ text: 'two' }],
        children: [
          {
            type: 'core/list',
            attrs: { ordered: true },
            children: [{ type: 'core/list-item', content: [{ text: 'nested' }] }],
          },
        ],
      },
    ],
  },
  quote: { type: 'core/quote', attrs: { citation: 'Someone' }, content: [{ text: 'Quoted' }] },
  'quote without citation': { type: 'core/quote', content: [{ text: 'Quoted' }] },
  code: {
    type: 'core/code',
    attrs: { language: 'ts' },
    content: [{ text: 'const a = 1;\nconst b = 2;' }],
  },
  embed: { type: 'core/embed', attrs: { url: 'https://youtu.be/dQw4w9WgXcQ' } },
  columns: {
    type: 'core/columns',
    children: [
      {
        type: 'core/column',
        children: [
          { type: 'core/paragraph', content: [{ text: 'left' }] },
          { type: 'core/heading', attrs: { level: 2 }, content: [{ text: 'h' }] },
        ],
      },
      {
        type: 'core/column',
        children: [{ type: 'core/button', attrs: { text: 'Go', href: '/go', style: 'outline' } }],
      },
    ],
  },
  button: { type: 'core/button', attrs: { text: 'Click', href: 'https://example.com' } },
};

describe('envelope <-> Tiptap JSON', () => {
  for (const [name, block] of Object.entries(fixtures)) {
    it(`round-trips ${name}`, () => {
      expect(blockFromTiptap(blockToTiptap(block))).toEqual(block);
    });
  }

  it('round-trips a whole document, including through JSON serialisation', () => {
    const original = doc(...Object.values(fixtures));
    const tiptap = JSON.parse(JSON.stringify(envelopeToTiptap(original)));
    expect(tiptapToEnvelope(tiptap)).toEqual(original);
  });

  it('every converted core block still validates and renders identically', () => {
    const registry = createBlockRegistry();
    const original = doc(...Object.values(fixtures));
    const back = tiptapToEnvelope(envelopeToTiptap(original));
    expect(validateDocument(back, registry)).toEqual([]);
    expect(renderBlocks(back.blocks, registry)).toBe(renderBlocks(original.blocks, registry));
  });

  it('keeps unknown (plugin) blocks untouched', () => {
    const plugin: Block = { type: 'acme/gallery', attrs: { ids: [1, 2] }, children: [{ type: 'x' }] };
    expect(blockToTiptap(plugin).type).toBe('npUnknown');
    expect(blockFromTiptap(blockToTiptap(plugin))).toEqual(plugin);
  });

  it('gives an empty document one empty paragraph, and a column at least one block', () => {
    expect(envelopeToTiptap(doc()).content).toEqual([{ type: 'paragraph' }]);
    expect(envelopeToTiptap(null).content).toEqual([{ type: 'paragraph' }]);
    const empty: Block = { type: 'core/columns', children: [{ type: 'core/column' }, { type: 'core/column' }] };
    expect(blockToTiptap(empty).content?.[0]?.content).toEqual([{ type: 'paragraph' }]);
  });

  it('drops empty text nodes, unknown marks and links without an href', () => {
    const result = blockFromTiptap({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a', marks: [{ type: 'highlight' }, { type: 'link', attrs: { href: '' } }] },
      ],
    });
    expect(result).toEqual({ type: 'core/paragraph', content: [{ text: 'a' }] });
  });
});
