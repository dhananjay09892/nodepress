import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UsageError } from './args.js';

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ScaffoldOptions {
  /** kebab-case name; also the folder name. */
  name: string;
  /** The folder that will contain `<name>`. */
  dir: string;
  title?: string | undefined;
  description?: string | undefined;
  /** Allow writing into a folder that already has files. */
  force?: boolean | undefined;
}

export interface ScaffoldResult {
  /** The new folder. */
  root: string;
  /** Paths of the files written, relative to `root`. */
  files: string[];
}

/** "reading-time" → "Reading Time". */
export function titleFromName(name: string): string {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function checkName(name: string, kind: 'plugin' | 'theme'): void {
  if (!NAME_PATTERN.test(name) || name.length > 64 || name === 'core') {
    throw new UsageError(
      `"${name}" is not a valid ${kind} name. Use lowercase letters, digits and dashes, like "my-${kind}".`,
    );
  }
}

async function writeFiles(
  options: ScaffoldOptions,
  files: Record<string, string>,
): Promise<ScaffoldResult> {
  const root = join(options.dir, options.name);
  let existing: string[] = [];
  try {
    existing = await readdir(root);
  } catch {
    // The folder does not exist yet; it is created below.
  }
  if (existing.length > 0 && !options.force) {
    throw new UsageError(`${root} already has files. Choose another name or use --force.`);
  }
  const written: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    written.push(path);
  }
  return { root, files: written };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Create a plugin package: `plugin.json`, a plain JavaScript entry that needs no build step, and
 * a README. The entry only uses types from `@nodepress/sdk` (in a comment), so the folder loads
 * as it is, from the site's plugins folder or after `nodepress plugin pack`.
 */
export async function scaffoldPlugin(options: ScaffoldOptions): Promise<ScaffoldResult> {
  checkName(options.name, 'plugin');
  const title = options.title ?? titleFromName(options.name);
  const description = options.description ?? `The ${title} plugin for NodePress.`;
  return writeFiles(options, {
    'plugin.json': json({
      name: options.name,
      version: '0.1.0',
      title,
      description,
      permissions: [],
      entry: 'index.js',
    }),
    // Makes Node read index.js as an ES module whatever the folder it is unpacked into.
    'package.json': json({ name: options.name, version: '0.1.0', private: true, type: 'module' }),
    'index.js': [
      '/** @type {import("@nodepress/sdk").PluginDefinition} */',
      'export default {',
      `  name: ${JSON.stringify(options.name)},`,
      "  version: '0.1.0',",
      `  description: ${JSON.stringify(description)},`,
      '  setup({ hooks, logger }) {',
      '    // Everything added through `hooks` is removed when the plugin is turned off.',
      "    hooks.addAction('core:ready', () => {",
      `      logger.info(${JSON.stringify(`${title} is ready`)});`,
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'README.md': [
      `# ${title}`,
      '',
      description,
      '',
      '## Try it',
      '',
      '```bash',
      `nodepress plugin check .      # validate plugin.json and load ${'`index.js`'}`,
      `nodepress plugin pack .       # make ${options.name}-0.1.0.zip`,
      '```',
      '',
      'Upload the zip on the **Plugins** screen of the admin, review the permissions it asks for,',
      'enable it, and restart the site (plugins load when it starts).',
      '',
      '## Permissions',
      '',
      'List what the plugin needs in `plugin.json` (`content:read`, `content:write`, `media:read`,',
      '`media:write`, `users:read`, `options:read`, `options:write`, `network`, `jobs`, `admin`,',
      '`database`). Site owners see them before enabling. A plugin that ships SQL files in',
      '`migrations/sqlite/` and `migrations/postgres/` must declare `database`.',
      '',
    ].join('\n'),
  });
}

/**
 * Create a theme: `theme.json`, TSX templates compiled by `npm run build` into `templates/`, and
 * a stylesheet. It mirrors the bundled Starter theme.
 */
export async function scaffoldTheme(options: ScaffoldOptions): Promise<ScaffoldResult> {
  checkName(options.name, 'theme');
  const title = options.title ?? titleFromName(options.name);
  const description = options.description ?? `The ${title} theme for NodePress.`;
  const cls = `np-${options.name}`;
  return writeFiles(options, {
    'theme.json': json({
      name: options.name,
      version: '0.1.0',
      title,
      description,
      supports: [],
      settings: {},
      templates: 'templates',
      assets: 'assets',
    }),
    'package.json': json({
      name: `nodepress-theme-${options.name}`,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: { build: 'tsc -p tsconfig.json' },
      dependencies: { hono: '^4.6.0' },
      devDependencies: { '@nodepress/core': '*', typescript: '^5.6.0' },
    }),
    'tsconfig.json': json({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        rootDir: 'src',
        outDir: 'templates',
        jsx: 'react-jsx',
        jsxImportSource: 'hono/jsx',
      },
      include: ['src'],
    }),
    'src/layout.tsx': [
      "import type { TemplateProps } from '@nodepress/core';",
      "import type { Child } from 'hono/jsx';",
      '',
      '/** The page frame shared by every template of this theme. */',
      'export function Layout(props: { page: TemplateProps; title: string; children?: Child }) {',
      '  const { page, title, children } = props;',
      '  return (',
      '    <html lang="en">',
      '      <head>',
      '        <meta charset="utf-8" />',
      '        <meta name="viewport" content="width=device-width, initial-scale=1" />',
      '        <title>{`${title} | ${page.siteName}`}</title>',
      '        <link rel="stylesheet" href={`${page.theme.assetsUrl}/style.css`} />',
      '      </head>',
      `      <body class="${cls}">`,
      '        <header>',
      '          <a href="/">{page.siteName}</a>',
      '        </header>',
      '        <main>{children}</main>',
      '      </body>',
      '    </html>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'src/index.tsx': [
      "import type { TemplateProps } from '@nodepress/core';",
      "import { Layout } from './layout.js';",
      '',
      '/** The last template in every hierarchy: draws whatever has no more specific template. */',
      'export default function Index(page: TemplateProps) {',
      '  if (page.status === 404) {',
      '    return (',
      '      <Layout page={page} title="Not found">',
      '        <h1>Page not found</h1>',
      '      </Layout>',
      '    );',
      '  }',
      '  const title = page.content?.title ?? page.siteName;',
      '  return (',
      '    <Layout page={page} title={title}>',
      '      <article>',
      '        <h1>{title}</h1>',
      "        <div dangerouslySetInnerHTML={{ __html: page.html ?? '' }} />",
      '      </article>',
      '    </Layout>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'assets/style.css': [
      `.${cls} { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; background: #fff; }`,
      `.${cls} header, .${cls} main { max-width: 42rem; margin: 0 auto; padding: 1rem; }`,
      `.${cls} a { color: #0b57d0; }`,
      `@media (prefers-color-scheme: dark) {`,
      `  .${cls} { color: #f2f2f2; background: #121212; }`,
      `  .${cls} a { color: #8ab4f8; }`,
      '}',
      '',
    ].join('\n'),
    'README.md': [
      `# ${title}`,
      '',
      description,
      '',
      'Install dependencies, then build the templates:',
      '',
      '```bash',
      'npm install',
      'npm run build',
      '```',
      '',
      `Put this folder in the site's \`themes\` folder and set \`THEME=${options.name}\`.`,
      '',
    ].join('\n'),
  });
}
