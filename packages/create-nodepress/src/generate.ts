import { randomBytes } from 'node:crypto';
import { InstallError, validateDatabaseUrl, type SiteOptions } from './options.js';

export type RandomHex = (bytes: number) => string;

const defaultRandom: RandomHex = (bytes) => randomBytes(bytes).toString('hex');

/**
 * One `.env` line. Plain values stay bare; anything else is quoted so spaces, `#` and `$` survive
 * Node's `--env-file` parser. Values that cannot be quoted safely are refused.
 */
export function envLine(key: string, value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value)) return `${key}=${value}`;
  if (/[\n\r]/.test(value)) throw new InstallError(key, `${key} cannot contain a line break.`);
  if (!value.includes("'")) return `${key}='${value}'`;
  if (!value.includes('"') && !value.includes('\\') && !value.includes('`')) {
    return `${key}="${value}"`;
  }
  throw new InstallError(
    key,
    `${key} cannot contain both ' and " (or backslashes or backticks) together; choose another value.`,
  );
}

export function generateEnv(options: SiteOptions, random: RandomHex = defaultRandom): string {
  const kind = validateDatabaseUrl(options.databaseUrl).kind;
  const lines = [
    '# NodePress settings. Keep this file private: it holds secrets and is not committed.',
    envLine('PORT', String(options.port)),
    envLine('SITE_NAME', options.siteName),
    ...(options.siteUrl ? [envLine('SITE_URL', options.siteUrl)] : []),
    envLine('DATABASE_URL', options.databaseUrl),
    ...(kind === 'libsql' && options.databaseAuthToken
      ? [envLine('DATABASE_AUTH_TOKEN', options.databaseAuthToken)]
      : []),
    '',
    '# The first administrator, created while the site has no users. You can delete these two',
    '# lines after the first start.',
    envLine('ADMIN_EMAIL', options.adminEmail),
    envLine('ADMIN_PASSWORD', options.adminPassword),
    '',
    '# Signs contact form tokens and webhook payloads.',
    envLine('CONTACT_SECRET', random(32)),
    envLine('WEBHOOK_SIGNING_KEY', random(32)),
    '',
    '# Cookies are Secure by default. Plain-HTTP addresses (http://localhost) need this off;',
    '# remove it when the site is served over HTTPS.',
    ...(options.siteUrl?.startsWith('https://') ? [] : ['COOKIE_SECURE=false']),
    '',
  ];
  return lines.join('\n');
}

export function generatePackageJson(options: SiteOptions): string {
  const main = `${options.from.replace(/\/+$/, '')}/apps/server/dist/main.js`;
  return `${JSON.stringify(
    {
      name: options.directory,
      version: '0.0.0',
      private: true,
      type: 'module',
      description: `${options.siteName}, a NodePress site`,
      scripts: {
        start: `node --env-file=.env ${JSON.stringify(main).slice(1, -1)}`,
        dev: `node --env-file=.env --watch ${JSON.stringify(main).slice(1, -1)}`,
      },
    },
    null,
    2,
  )}\n`;
}

export function generateReadme(options: SiteOptions): string {
  return `# ${options.siteName}

A NodePress site. Start it with:

\`\`\`bash
npm start
\`\`\`

Then open http://localhost:${options.port}/admin/ and sign in as ${options.adminEmail}.

- \`.env\`: the site's settings and secrets (never commit it). After the first start you can delete
  the \`ADMIN_EMAIL\` and \`ADMIN_PASSWORD\` lines.
- \`plugins-installed/\`: plugin packages (\`plugin.json\` plus a built entry); manage them in the admin.
- \`media/\`: uploaded files.
- \`nodepress.db\`: the database, when you chose SQLite. Back it up together with \`media/\`.

This site runs the NodePress server in \`${options.from}\`. Rebuild it there (\`pnpm build\`)
after updating NodePress.
`;
}

export const GITIGNORE = `.env
node_modules/
nodepress.db
nodepress.db-*
media/
`;

/** Every file of a new site, as `path → content`. Paths are relative and use `/`. */
export function generateProject(
  options: SiteOptions,
  random: RandomHex = defaultRandom,
): Map<string, string> {
  return new Map([
    ['.env', generateEnv(options, random)],
    ['.gitignore', GITIGNORE],
    ['package.json', generatePackageJson(options)],
    ['README.md', generateReadme(options)],
    ['plugins-installed/.gitkeep', ''],
  ]);
}
