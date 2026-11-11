import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useMemo, useRef } from 'react';
import { envelopeToTiptap, tiptapToEnvelope, type TiptapDoc } from '../tiptap-json.js';
import type { BlockDocument } from '../types.js';
import { createExtensions } from './extensions.js';

export interface BlockEditorProps {
  /** Initial document. Later changes to this prop replace the content only if they differ from the last emitted value. */
  value: BlockDocument;
  onChange: (document: BlockDocument) => void;
  /** Accessible name for the editing area (read when the editor is created). */
  label?: string;
}

const buttonClass =
  'rounded border border-slate-400 bg-white px-2 py-1 text-sm text-slate-900 hover:bg-slate-50 aria-pressed:bg-slate-900 aria-pressed:text-white';

function ToolbarButton(props: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children?: string;
}) {
  return (
    <button
      type="button"
      className={buttonClass}
      aria-label={props.label}
      {...(props.active === undefined ? {} : { 'aria-pressed': props.active })}
      onClick={props.onClick}
    >
      {props.children ?? props.label}
    </button>
  );
}

function ask(message: string, fallback = ''): string | null {
  const answer = window.prompt(message, fallback);
  return answer === null || answer.trim() === '' ? null : answer.trim();
}

function Toolbar({ editor }: { editor: Editor }) {
  const run = () => editor.chain().focus();
  return (
    <div role="toolbar" aria-label="Formatting" className="mb-2 flex flex-wrap gap-1">
      <ToolbarButton label="Bold" active={editor.isActive('bold')} onClick={() => run().toggleBold().run()}>
        B
      </ToolbarButton>
      <ToolbarButton label="Italic" active={editor.isActive('italic')} onClick={() => run().toggleItalic().run()}>
        I
      </ToolbarButton>
      <ToolbarButton label="Underline" active={editor.isActive('underline')} onClick={() => run().toggleUnderline().run()}>
        U
      </ToolbarButton>
      <ToolbarButton label="Strikethrough" active={editor.isActive('strike')} onClick={() => run().toggleStrike().run()}>
        S
      </ToolbarButton>
      <ToolbarButton label="Inline code" active={editor.isActive('code')} onClick={() => run().toggleCode().run()}>
        {'</>'}
      </ToolbarButton>
      <ToolbarButton
        label="Link"
        active={editor.isActive('link')}
        onClick={() => {
          const current = (editor.getAttributes('link')['href'] as string | undefined) ?? '';
          const href = ask('Link URL (leave empty to remove)', current);
          if (href === null) run().unsetLink().run();
          else run().setLink({ href }).run();
        }}
      />
      <ToolbarButton label="Paragraph" active={editor.isActive('paragraph')} onClick={() => run().setParagraph().run()} />
      {([1, 2, 3, 4] as const).map((level) => (
        <ToolbarButton
          key={level}
          label={`Heading ${level}`}
          active={editor.isActive('heading', { level })}
          onClick={() => run().toggleHeading({ level }).run()}
        >
          {`H${level}`}
        </ToolbarButton>
      ))}
      <ToolbarButton label="Bulleted list" active={editor.isActive('bulletList')} onClick={() => run().toggleBulletList().run()} />
      <ToolbarButton label="Numbered list" active={editor.isActive('orderedList')} onClick={() => run().toggleOrderedList().run()} />
      <ToolbarButton
        label="Quote"
        active={editor.isActive('npQuote')}
        onClick={() => {
          if (editor.isActive('npQuote')) run().setParagraph().run();
          else run().setNode('npQuote').run();
        }}
      />
      <ToolbarButton label="Code block" active={editor.isActive('codeBlock')} onClick={() => run().toggleCodeBlock().run()} />
      <ToolbarButton
        label="Image"
        onClick={() => {
          const src = ask('Image URL');
          if (!src) return;
          const alt = window.prompt('Alt text (empty for a decorative image)', '') ?? '';
          run().insertContent({ type: 'npImage', attrs: { src, alt } }).run();
        }}
      />
      <ToolbarButton
        label="Embed"
        onClick={() => {
          const url = ask('Video or page URL (https://…)');
          if (url) run().insertContent({ type: 'npEmbed', attrs: { url } }).run();
        }}
      />
      <ToolbarButton
        label="Button"
        onClick={() => {
          const text = ask('Button text');
          const href = text ? ask('Button link') : null;
          if (text && href) run().insertContent({ type: 'npButton', attrs: { text, href } }).run();
        }}
      />
      <ToolbarButton
        label="Columns"
        onClick={() => {
          const column = { type: 'npColumn', content: [{ type: 'paragraph' }] };
          run().insertContent({ type: 'npColumns', content: [column, column] }).run();
        }}
      />
      <ToolbarButton label="Undo" onClick={() => run().undo().run()} />
      <ToolbarButton label="Redo" onClick={() => run().redo().run()} />
    </div>
  );
}

/** Tiptap-based block editor. Emits the NodePress block envelope, never raw ProseMirror JSON. */
export function BlockEditor({ value, onChange, label = 'Content' }: BlockEditorProps) {
  const extensions = useMemo(() => createExtensions(), []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions,
    content: envelopeToTiptap(value),
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        class: 'np-editor-content min-h-48 rounded border border-slate-400 bg-white p-3 focus:outline-2',
      },
    },
    onUpdate: ({ editor: current }) => {
      onChangeRef.current(tiptapToEnvelope(current.getJSON() as TiptapDoc));
    },
  });

  if (!editor) return null;
  return (
    <div>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
