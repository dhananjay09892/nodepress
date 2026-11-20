import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstaller, type CliIo } from './cli.js';
import { envLine, generateEnv, generatePackageJson, generateProject } from './generate.js';
import {
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

const fixedRandom = (bytes: number) => 'ab'.repeat(bytes);

const site: SiteOptions = {
  directory: 'my-site',
  siteName: 'My Site',
  adminEmail: 'owner@example.com',
  adminPassword: 'a-long-password-1',
  databaseUrl: 'file:./nodepress.db',
  port: 3000,
  from: '/opt/nodepress',
};

let dir: string;
let checkout: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'np-create-'));
  checkout = join(dir, 'checkout');
  await mkdir(join(checkout, 'apps', 'server', 'dist'), { recursive: true });
  await writeFile(join(checkout, 'apps', 'server', 'dist', 'main.js'), '');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('validation', () => {
  it('accepts good values and cleans them', () => {
    expect(validateDirectory(' my-site ')).toBe('my-site');
    expect(validateSiteName('  My   Site ')).toBe('My Site');
    expect(validateEmail(' a@b.co ')).toBe('a@b.co');
    expect(validatePassword('twelve chars!')).toBe('twelve chars!');
    expect(validatePort('8080')).toBe(8080);
    expect(validateSiteUrl('https://example.com/path?x=1')).toBe('https://example.com');
    expect(validateSiteUrl('')).toBeUndefined();
  });

  it('refuses bad values with an InstallError naming the field', () => {
    const cases: Array<[() => unknown, string]> = [
      [() => validateDirectory('My Site'), 'directory'],
      [() => validateDirectory('../x'), 'directory'],
      [() => validateSiteName(''), 'siteName'],
      [() => validateSiteName('a\u0000b'), 'siteName'],
      [() => validateEmail('nope'), 'adminEmail'],
      [() => validateEmail('a@b.co\nBcc: x@y.z'), 'adminEmail'],
      [() => validatePassword('short'), 'adminPassword'],
      [() => validatePassword('a-long-password\n1'), 'adminPassword'],
      [() => validatePort('0'), 'port'],
      [() => validatePort('abc'), 'port'],
      [() => validateSiteUrl('ftp://x.y'), 'siteUrl'],
      [() => validateDatabaseUrl('mysql://x/y'), 'databaseUrl'],
      [() => validateDatabaseUrl('postgres://host'), 'databaseUrl'],
    ];
    for (const [run, field] of cases) {
      expect(run).toThrow(InstallError);
      try {
        run();
      } catch (error) {
        expect((error as InstallError).field).toBe(field);
      }
    }
  });

  it('recognises the three databases and defaults to SQLite', () => {
    expect(validateDatabaseUrl('')).toEqual({ url: 'file:./nodepress.db', kind: 'sqlite' });
    expect(validateDatabaseUrl('postgres://u:p@h:5432/db').kind).toBe('postgres');
    expect(validateDatabaseUrl('postgresql://u:p@h/db').kind).toBe('postgres');
    expect(validateDatabaseUrl('libsql://name.turso.io').kind).toBe('libsql');
  });
});

describe('generated files', () => {
  it('envLine keeps plain values bare and quotes the rest', () => {
    expect(envLine('A', 'plain-1.2/x')).toBe('A=plain-1.2/x');
    expect(envLine('A', 'two words # not a comment')).toBe("A='two words # not a comment'");
    expect(envLine('A', "it's $fine")).toBe('A="it\'s $fine"');
    expect(() => envLine('A', 'a\nb')).toThrow(InstallError);
    expect(() => envLine('A', `both ' and "`)).toThrow(InstallError);
  });

  it('the .env has the settings, random secrets and COOKIE_SECURE=false for http', () => {
    const env = generateEnv({ ...site, siteUrl: 'http://localhost:3000' }, fixedRandom);
    expect(env).toContain('PORT=3000');
    expect(env).toContain("SITE_NAME='My Site'");
    expect(env).toContain('DATABASE_URL=file:./nodepress.db');
    expect(env).toContain('ADMIN_EMAIL=owner@example.com');
    expect(env).toContain(`CONTACT_SECRET=${'ab'.repeat(32)}`);
    expect(env).toContain(`WEBHOOK_SIGNING_KEY=${'ab'.repeat(32)}`);
    expect(env).toContain('COOKIE_SECURE=false');
    expect(env).not.toContain('DATABASE_AUTH_TOKEN');
  });

  it('an https site keeps Secure cookies; a Turso token is written only for libsql', () => {
    const https = generateEnv({ ...site, siteUrl: 'https://example.com' }, fixedRandom);
    expect(https).not.toContain('COOKIE_SECURE');
    expect(https).toContain('SITE_URL=https://example.com');
    const turso = generateEnv(
      { ...site, databaseUrl: 'libsql://a.turso.io', databaseAuthToken: 'tok' },
      fixedRandom,
    );
    expect(turso).toContain('DATABASE_AUTH_TOKEN=tok');
    const sqlite = generateEnv({ ...site, databaseAuthToken: 'tok' }, fixedRandom);
    expect(sqlite).not.toContain('DATABASE_AUTH_TOKEN');
  });

  it('random secrets differ between sites by default', () => {
    expect(generateEnv(site)).not.toBe(generateEnv(site));
  });

  it('package.json runs the checkout server with the .env file', () => {
    const pkg = JSON.parse(generatePackageJson(site)) as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe('my-site');
    expect(pkg.scripts.start).toBe('node --env-file=.env /opt/nodepress/apps/server/dist/main.js');
    expect(pkg.scripts.dev).toContain('--watch');
  });

  it('a path with quotes is escaped in package.json', () => {
    const pkg = JSON.parse(generatePackageJson({ ...site, from: '/opt/my "np"' })) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.start).toContain('/opt/my \\"np\\"/apps/server/dist/main.js');
  });

  it('the project lists .env in .gitignore', () => {
    const files = generateProject(site, fixedRandom);
    expect([...files.keys()].sort()).toEqual([
      '.env',
      '.gitignore',
      'README.md',
      'package.json',
      'plugins-installed/.gitkeep',
    ]);
    expect(files.get('.gitignore')).toContain('.env');
    expect(files.get('README.md')).toContain('owner@example.com');
  });
});

describe('writeProject', () => {
  it('writes the files and keeps .env private', async () => {
    const target = join(dir, 'site');
    await writeProject(target, generateProject(site, fixedRandom));
    expect(await readFile(join(target, 'package.json'), 'utf8')).toContain('my-site');
    expect((await stat(join(target, '.env'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(target, 'plugins-installed'))).isDirectory()).toBe(true);
  });

  it('uses an existing empty folder but never overwrites a folder with files', async () => {
    const empty = join(dir, 'empty');
    await mkdir(empty);
    await writeProject(empty, new Map([['a.txt', 'a']]));
    await expect(writeProject(empty, new Map([['a.txt', 'b']]))).rejects.toThrow(/not empty/);
    expect(await readFile(join(empty, 'a.txt'), 'utf8')).toBe('a');
  });

  it('refuses a file path that leaves the folder', async () => {
    await expect(writeProject(join(dir, 'x'), new Map([['../escape.txt', 'x']]))).rejects.toThrow(
      /outside/,
    );
    await expect(stat(join(dir, 'escape.txt'))).rejects.toThrow();
  });
});

function makeIo(extra: Partial<CliIo> = {}): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l) => void lines.push(l),
    err: (l) => void errors.push(l),
    cwd: dir,
    env: {},
    random: fixedRandom,
    ...extra,
  };
}

describe('runInstaller', () => {
  const flags = (extra: string[] = []) => [
    'new-site',
    '--yes',
    '--admin-email=owner@example.com',
    '--admin-password=a-long-password-1',
    `--from=${join(dir, 'checkout')}`,
    ...extra,
  ];

  it('creates a site non-interactively', async () => {
    const io = makeIo();
    expect(await runInstaller(flags(['--site-name=Hello World', '--port=4000']), io)).toBe(0);
    const env = await readFile(join(dir, 'new-site', '.env'), 'utf8');
    expect(env).toContain("SITE_NAME='Hello World'");
    expect(env).toContain('PORT=4000');
    expect(io.lines.join('\n')).toContain('npm start');
    expect(io.lines.join('\n')).not.toContain('password (shown once');
  });

  it('makes and shows a password when none is given', async () => {
    const io = makeIo();
    const argv = flags().filter((a) => !a.startsWith('--admin-password'));
    expect(await runInstaller(argv, io)).toBe(0);
    expect(io.lines.join('\n')).toContain(
      `password (shown once, also in .env): ${'ab'.repeat(10)}`,
    );
  });

  it('asks questions when interactive and re-asks after a bad answer', async () => {
    const answers = ['Asked Site', 'bad-email', 'asker@example.com', '', '', '', ''];
    const asked: string[] = [];
    const io = makeIo({
      ask: async (q) => {
        asked.push(q);
        return answers.shift() ?? '';
      },
    });
    expect(await runInstaller(['asked-site', `--from=${checkout}`], io)).toBe(0);
    expect(io.errors.join('\n')).toContain('valid email');
    const env = await readFile(join(dir, 'asked-site', '.env'), 'utf8');
    expect(env).toContain("SITE_NAME='Asked Site'");
    expect(env).toContain('ADMIN_EMAIL=asker@example.com');
    expect(env).toContain(`ADMIN_PASSWORD=${'ab'.repeat(10)}`);
    expect(asked.length).toBeGreaterThanOrEqual(6);
  });

  it('refuses without --from, with a build-less checkout, and with a bad folder name', async () => {
    const noFrom = makeIo();
    expect(await runInstaller(['x1', '--yes', '--admin-email=a@b.co'], noFrom)).toBe(1);
    expect(noFrom.errors.join('\n')).toContain('not published to npm');
    const unbuilt = makeIo();
    expect(
      await runInstaller(
        flags().map((a) => (a.startsWith('--from') ? `--from=${dir}` : a)),
        unbuilt,
      ),
    ).toBe(1);
    expect(unbuilt.errors.join('\n')).toContain('pnpm build');
    const bad = makeIo();
    expect(await runInstaller(['Bad Name', ...flags().slice(1)], bad)).toBe(1);
  });

  it('refuses a folder that already has files and says so', async () => {
    await mkdir(join(dir, 'taken'));
    await writeFile(join(dir, 'taken', 'a'), '');
    const io = makeIo();
    expect(await runInstaller(['taken', ...flags().slice(1)], io)).toBe(1);
    expect(io.errors.join('\n')).toContain('not empty');
  });

  it('NODEPRESS_HOME stands in for --from, and a missing folder name prints help', async () => {
    const io = makeIo({ env: { NODEPRESS_HOME: checkout } });
    const argv = flags().filter((a) => !a.startsWith('--from'));
    expect(await runInstaller(argv, io)).toBe(0);
    const none = makeIo();
    expect(await runInstaller(['--yes'], none)).toBe(2);
    expect(none.errors.join('\n')).toContain('Usage');
    const help = makeIo();
    expect(await runInstaller(['--help'], help)).toBe(0);
    expect(help.lines.join('\n')).toContain('create-nodepress');
  });
});
