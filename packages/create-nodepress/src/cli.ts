import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { generateProject, type RandomHex } from './generate.js';
import {
  DEFAULT_DATABASE_URL,
  InstallError,
  validateDatabaseUrl,
  validateDirectory,
  validateEmail,
  validatePassword,
  validatePort,
  validateSiteName,
  validateSiteUrl,
  type SiteOptions,
} from './options.js';
import { writeProject } from './write.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Asks one question; returns the typed answer (empty means "use the default"). Not set when not interactive. */
  ask?: (question: string) => Promise<string>;
  random?: RandomHex;
  /** Whether a file exists. Replaced in tests. */
  isFile?: (path: string) => Promise<boolean>;
}

export const HELP = `create-nodepress: create a NodePress site

Usage:
  create-nodepress <folder> [options]

Without --yes it asks for each setting. With --yes it uses the options below and the defaults.

Options:
  --site-name <text>         Site title (default: My NodePress Site)
  --admin-email <email>      The first administrator's email (asked; required with --yes)
  --admin-password <text>    Their password, 12+ characters (a random one is made and shown if left out)
  --database <url>           file:./nodepress.db (default), postgres://user:pass@host:5432/db or libsql://…
  --database-token <text>    Turso token for libsql:// addresses
  --port <number>            Port the site listens on (default 3000)
  --site-url <url>           Public address, for example https://example.com (optional)
  --from <folder>            A built NodePress checkout whose server the site runs (or set NODEPRESS_HOME)
  --yes, -y                  Do not ask questions
  --help, -h                 Show this help

NodePress is not published to npm yet, so a site runs the server of a NodePress checkout you have
built with "pnpm build". See docs/adr/0002-distribution.md.
`;

const BOOLEAN_FLAGS = new Set(['yes', 'help']);

function parse(argv: readonly string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h') flags.help = true;
    else if (arg === '-y') flags.yes = true;
    else if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Returns the process exit code. */
export async function runInstaller(argv: readonly string[], io: CliIo): Promise<number> {
  const { positional, flags } = parse(argv);
  if (flags.help) {
    io.out(HELP);
    return 0;
  }
  try {
    const random = io.random ?? ((bytes) => randomBytes(bytes).toString('hex'));
    const interactive = flags.yes !== true && io.ask !== undefined;
    const text = (name: string): string | undefined =>
      typeof flags[name] === 'string' ? (flags[name] as string) : undefined;

    /** A flag value, else (when interactive) an answer, else the default. */
    async function value<T>(
      flag: string,
      question: string,
      fallback: string,
      check: (raw: string) => T,
    ): Promise<T> {
      const given = text(flag);
      if (given !== undefined) return check(given);
      if (interactive) {
        for (;;) {
          const answer = (await io.ask!(`${question}${fallback ? ` (${fallback})` : ''}: `)).trim();
          try {
            return check(answer || fallback);
          } catch (error) {
            if (!(error instanceof InstallError)) throw error;
            io.err(`  ${error.message}`);
          }
        }
      }
      return check(fallback);
    }

    const folder = positional[0] ?? (interactive ? (await io.ask!('Folder for the new site: ')).trim() : '');
    if (!folder) {
      io.err('Say where to create the site: create-nodepress <folder>\n');
      io.err(HELP);
      return 2;
    }
    const directory = validateDirectory(folder.split(/[\\/]/).pop() ?? folder);

    const siteName = await value('site-name', 'Site name', 'My NodePress Site', validateSiteName);
    const adminEmail = await value('admin-email', 'Administrator email', '', validateEmail);
    let generatedPassword: string | undefined;
    const givenPassword = text('admin-password');
    let adminPassword: string;
    if (givenPassword !== undefined) adminPassword = validatePassword(givenPassword);
    else if (interactive) {
      adminPassword = await value('admin-password', 'Administrator password, 12+ characters (empty makes one)', '', (raw) =>
        raw === '' ? '' : validatePassword(raw),
      );
      if (adminPassword === '') adminPassword = generatedPassword = random(10);
    } else adminPassword = generatedPassword = random(10);

    const database = await value('database', 'Database address', DEFAULT_DATABASE_URL, validateDatabaseUrl);
    const databaseAuthToken =
      database.kind === 'libsql'
        ? (text('database-token') ?? (interactive ? (await io.ask!('Turso auth token: ')).trim() : undefined))
        : undefined;
    const port = await value('port', 'Port', '3000', validatePort);
    const siteUrl = await value('site-url', 'Public address, optional', '', validateSiteUrl);

    const fromRaw =
      text('from') ??
      io.env.NODEPRESS_HOME ??
      (interactive ? (await io.ask!('Path to a built NodePress checkout: ')).trim() : '');
    if (!fromRaw) {
      throw new InstallError(
        'from',
        'NodePress is not published to npm yet. Pass --from <folder of a built NodePress checkout> (see --help).',
      );
    }
    const from = isAbsolute(fromRaw) ? resolve(fromRaw) : resolve(io.cwd, fromRaw);
    const isFile = io.isFile ?? defaultIsFile;
    if (!(await isFile(join(from, 'apps', 'server', 'dist', 'main.js')))) {
      throw new InstallError(
        'from',
        `${from} has no built server (apps/server/dist/main.js). Run "pnpm build" there first.`,
      );
    }

    const options: SiteOptions = {
      directory,
      siteName,
      adminEmail,
      adminPassword,
      databaseUrl: database.url,
      databaseAuthToken,
      port,
      siteUrl,
      from,
    };
    const target = resolve(io.cwd, folder);
    await writeProject(target, generateProject(options, random));

    io.out(`Created ${siteName} in ${target}`);
    if (generatedPassword) {
      io.out(`Administrator password (shown once, also in .env): ${generatedPassword}`);
    }
    io.out('');
    io.out('Next:');
    io.out(`  cd ${folder}`);
    io.out('  npm start');
    io.out(`Then open http://localhost:${port}/admin/ and sign in as ${adminEmail}.`);
    return 0;
  } catch (error) {
    if (error instanceof InstallError) {
      io.err(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
