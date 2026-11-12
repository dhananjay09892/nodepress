# ADR 0001: Block editor engine

- Status: Accepted (2026-11-11)
- Date: 2026-11-11
- Related: PLAN.md section 2 (stack) and section 8, open decision 2; queue tasks N16, N17, N18

Decision: Tiptap (MIT packages only), behind NodePress's own block envelope. Chosen by the owner on 2026-11-11.

<!-- Owner: write "Lexical" or "Tiptap" (or another choice) on the line above, then remove the "Needs you" line from N17 in docs/QUEUE.md. -->

## Context

NodePress needs a block editor in the admin (`apps/admin`) and a new `packages/editor` package. Requirements taken from PLAN.md:

- Content is stored as **JSON blocks** in `content.body`, so it can be rendered on the server to HTML and exposed through the API.
- A **block registry** that plugins extend (`register content types/fields/blocks`).
- Core blocks: paragraph, heading, image, list, quote, code, embed, columns, button.
- React 19 admin, Vite, TypeScript strict, ESM only, MIT licence for the project.
- Server-side rendering of stored JSON to HTML with **no browser or DOM dependency** (themes render on the server).
- WCAG 2.1 AA for the admin as well as the front end.

## How this was evaluated

The first version of this record was written in an automated session where the npm registry was unreachable, so it rested on the public documentation and design of both projects. After the owner chose Tiptap, N17 and N44 built the integration and N45 measured it in GitHub Actions (Ubuntu runner, Node 22, `vite build` production output, run on 2026-11-12). Every claim that used to be marked unverified now carries either a measured result for Tiptap or the statement that it was **not measured** because Lexical was not built. The measured numbers are in "Measurements (N45)" below.

## Options

### Option A: Lexical (Meta)

An extensible text editor framework with a small core and a React binding (`@lexical/react`).

- **Block model:** a tree of nodes (`ElementNode`, `DecoratorNode`, `TextNode`). Blocks are custom node classes; non-text blocks (image, embed, button) are `DecoratorNode`s that render React components. Columns would be a custom `ElementNode` with child column nodes.
- **JSON storage:** editor state serialises to JSON natively (`editorState.toJSON()`), with a versioned node format. Each node type defines `exportJSON` / `importJSON`, so the stored shape is ours to control per block. The JSON is Lexical-specific (nodes like `root`, `paragraph`, `text` with numeric format bitfields), which is more tied to the engine than Tiptap's output.
- **Extension API:** nodes, commands, plugins (React components or imperative registrations) and a newer `defineExtension` direction (not evaluated: Lexical was not built). Plugin authors write TypeScript classes plus React components.
- **Server-side rendering:** Lexical is designed around a live editor instance; headless use exists (`@lexical/headless`) but rendering HTML from stored JSON would normally mean our own small renderer that walks the JSON. For a block registry that already needs a renderer per block this is fine and keeps the server free of the editor.
- **Bundle size:** core is small (order of 20-30 kB gzipped for core plus React binding, more with rich text, lists, links and code packages); not measured, since Lexical was not built. Generally lighter than a ProseMirror stack.
- **Licence:** MIT.
- **Accessibility:** contenteditable-based with ARIA support in the rich text package; keyboard handling and screen reader behaviour for custom decorator blocks are our responsibility (not tested, since Lexical was not built).
- **Maturity and risks:** used in production by Meta and others; API has been pre-1.0 for a long time and has had breaking changes between minor versions (current version and stability policy not checked). Smaller ecosystem of ready-made block-level extensions than Tiptap; tables, collaborative editing (Yjs) and markdown shortcuts exist as packages.

### Option B: Tiptap (on ProseMirror)

A headless editor framework built on ProseMirror, with React bindings (`@tiptap/react`).

- **Block model:** a ProseMirror schema of nodes and marks. Blocks are Tiptap `Node` extensions; non-text blocks use `ReactNodeViewRenderer`. Columns are a custom node with a constrained content expression (`column+`), which ProseMirror's schema handles well.
- **JSON storage:** documents serialise to a plain, stable, schema-shaped JSON (`{ type: "doc", content: [...] }`) via `editor.getJSON()`. ProseMirror JSON is a widely used format with a long track record, and there are libraries to render it without a browser.
- **Extension API:** mature and well documented. Each extension declares schema, commands, keyboard shortcuts, input rules and node views in one place, which maps cleanly onto "plugins register blocks".
- **Server-side rendering:** `@tiptap/html` can generate HTML from JSON on the server, but it relies on a DOM implementation (it has used `zeed-dom` or similar for Node). **Measured:** we do not use it. NodePress renders its own block envelope with the registry-driven renderer in `@nodepress/editor`, which runs in plain Node with no `document` or `window` global (see Measurements).
- **Bundle size:** larger than Lexical because ProseMirror packages (state, view, model, transform, commands, keymap and more) come with it; **Measured: the editor adds about 170 kB gzipped** (623 kB minified) on top of React, well above the 50-100 kB first estimate. See Measurements.
- **Licence:** Tiptap core and most extensions are MIT. Some features (collaboration cloud, AI, some pro extensions) are commercial. We would only depend on the MIT packages. ProseMirror itself is MIT.
- **Accessibility:** also contenteditable; ProseMirror has a long record of handling IME, selection and clipboard edge cases. Custom node views need our own ARIA and keyboard work. **Measured:** the toolbar (a `role=toolbar` group of labelled buttons) and the editing area (`role=textbox`, `aria-multiline`, accessible name) can be operated with the keyboard alone, covered by the Playwright test `editor-keyboard.spec.ts`. A screen reader pass has not been done and needs a person.
- **Maturity and risks:** Tiptap 2.x is stable and widely deployed; the integration was built directly on the 3.x line (3.33.1 at measurement time), so there was no 2.x to 3.x migration. A commercial company drives it, so the risk is feature gating over time rather than abandonment.

## Comparison

| Criterion                      | Lexical                                   | Tiptap                                              |
| ------------------------------ | ----------------------------------------- | --------------------------------------------------- |
| Block / node model             | Custom node classes, decorators for React | Schema-based nodes, node views for React            |
| Stored JSON                    | Lexical-specific tree, versioned          | ProseMirror JSON, stable and widely understood      |
| Nested layout blocks (columns) | Possible, more manual                     | Natural via schema content expressions              |
| Plugin extension API           | Nodes + commands + React plugins          | Single `Extension` / `Node` object, well documented |
| Server-side HTML               | Own renderer over JSON                    | `@tiptap/html` (DOM-based) or own renderer          |
| Bundle size (rough)            | Not measured (not built)                  | About 170 kB gzip added to the admin (measured)     |
| Licence                        | MIT                                       | MIT core, some paid add-ons we would avoid          |
| Ecosystem / docs               | Smaller, improving                        | Larger, many examples                               |
| API stability                  | Historically pre-1.0 churn (not checked)  | 3.x line, major migrations occasionally             |
| Governance                     | Meta open source                          | Company-backed, open core                           |

## Trade-offs that matter for NodePress

1. **Plugin authors.** The plugin system is a core promise. A single declarative extension object that carries schema, rendering, shortcuts and commands (Tiptap) is easier to document and to type than Lexical's split between node classes, commands and plugins. Lexical's flexibility is real but the learning curve for third parties is steeper.
2. **Stored JSON as public API.** Whatever we pick becomes the shape of `content.body` and of API responses. We should wrap it in our own block envelope either way (`{ version, blocks: [{ type, attrs, children }] }`) and convert at the editor boundary, so a later engine swap does not break stored content or plugins. This reduces the cost of choosing wrong.
3. **Server rendering.** Both options should render through our own registry-driven renderer so themes never need the editor or a DOM. That makes the "server render" row a tie.
4. **Bundle size.** The admin is behind a login and loaded once, so a 30-50 kB difference matters less than for the public front end. It still counts against the admin performance budget (N41).
5. **Licence and lock-in.** Both MIT at the level we need. Tiptap's commercial layer is a watch item. Lexical's churn is a watch item too.

## Recommendation

**Tiptap (MIT packages only), behind our own block envelope.**

Reasons: the schema-based node model fits nested layout blocks such as columns, the single-object extension API is the better fit for plugin-registered blocks, and the ProseMirror foundation is the most battle-tested for the editing edge cases (selection, IME, paste, undo) that a CMS editor cannot afford to get wrong. The cost is a larger bundle, which is acceptable for a logged-in admin.

Choose **Lexical** instead if bundle size and a lighter core outweigh plugin-author ergonomics for you, or if you want to avoid any dependence on a vendor with a paid tier. Nothing here makes Lexical a bad choice; the case for Tiptap is ergonomics and maturity.

Either way, N17 should store our own block envelope and keep `packages/editor` as the only package that imports the engine.

## Measurements (N45)

Produced by `apps/admin/scripts/measure-editor.mjs`, which the admin job in `.github/workflows/ci.yml` runs after `pnpm build` (so the numbers reappear in every CI log). Packages measured: `@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit` and `@tiptap/pm`, all 3.33.1, all MIT.

| Measurement                                              | Result                                          |
| -------------------------------------------------------- | ----------------------------------------------- |
| React + ReactDOM only (probe bundle)                     | 355.0 kB minified, 80.0 kB gzip                 |
| React + ReactDOM + `BlockEditor` (probe bundle)          | 978.1 kB minified, 250.3 kB gzip                |
| **Editor adds**                                          | **623.1 kB minified, 170.3 kB gzip**            |
| Whole admin build (`dist/assets`, one JS chunk)          | 244.3 kB gzip (React, router, query and editor) |
| Server render round trip, all nine core blocks           | 9 of 9 identical after envelope to Tiptap to envelope; every document passes `validateDocument` and renders HTML |
| Server render needs a DOM                                | No: ran with no `document` or `window` global   |
| Keyboard-only use of the toolbar (Playwright, Chromium)  | Pass: Shift+Tab reaches "Heading 2", Space applies it, typing then produces a `core/heading` block |

Notes:

- The editor currently ships inside the single admin chunk because `/editor-preview` imports it statically, so every admin page pays for it. N18 (post edit screen) should load the editor with a dynamic `import()` on the edit route only. The cost is acceptable for a logged-in admin but counts against the N41 performance budget.
- The round-trip probe covers one representative block per core type. The exhaustive fixtures (marks, nested lists, empty blocks, media-library images) are in `packages/editor/src/tiptap-json.test.ts`.
- Not done: a screen reader test (needs a person) and any measurement of Lexical (not built, since Tiptap was chosen).

## Consequences

- PLAN.md section 2, section 8 and the Phase 2 spike checkbox are updated to reflect Tiptap.
- N17 is unblocked: `packages/editor` is the only package that imports Tiptap, and it stores NodePress's own block envelope rather than raw ProseMirror JSON.
- N45 measured the Tiptap integration; the editor adds about 170 kB gzip, which N18 should offset by lazy-loading it.
