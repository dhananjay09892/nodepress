/**
 * Database access for plugins: parameterized queries on the plugin's own tables only.
 *
 * A plugin named `my-plugin` owns the tables whose names start with `my_plugin_` (create them in a
 * migration, see `plugin-packages.ts`). `query()` and `execute()` take one statement with `?`
 * placeholders and a list of values; values never become part of the SQL text. The text itself is
 * checked before it runs: only `SELECT`, `INSERT`, `UPDATE` and `DELETE`, one statement, no
 * comments, no quotes (so no string literals and no quoted names), and every table the statement
 * names must belong to the plugin. This is a guard against mistakes and against a plugin
 * reaching core tables by accident; the `database` permission shown to the site owner remains
 * the real statement of trust, because a plugin's migrations run unrestricted SQL.
 */

export class PluginSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSqlError';
  }
}

export type SqlValue = string | number | boolean | null | Uint8Array | Date;
export type SqlRow = Record<string, unknown>;

/** Runs one statement with values bound to its `?` placeholders. `@nodepress/db` provides it. */
export interface ParameterizedSqlRunner {
  readonly dialect: 'sqlite' | 'postgres';
  query(statement: string, values: readonly SqlValue[]): Promise<SqlRow[]>;
  execute(statement: string, values: readonly SqlValue[]): Promise<void>;
}

/** What `context.db` gives a plugin that declared the `database` permission. */
export interface PluginDatabase {
  /** Table name prefix this plugin owns, for example `my_plugin_`. */
  readonly prefix: string;
  /** Run a `SELECT` and return the rows. */
  query(statement: string, values?: readonly SqlValue[]): Promise<SqlRow[]>;
  /** Run an `INSERT`, `UPDATE` or `DELETE`. */
  execute(statement: string, values?: readonly SqlValue[]): Promise<void>;
}

/** `my-plugin` → `my_plugin_`. */
export function pluginTablePrefix(pluginName: string): string {
  return `${pluginName.replace(/-/g, '_')}_`;
}

const MAX_STATEMENT_LENGTH = 20_000;
const MAX_VALUES = 500;

/**
 * Check a statement for `pluginName`. Returns nothing; throws `PluginSqlError` with the reason.
 */
export function checkPluginSql(
  pluginName: string,
  statement: string,
  values: readonly unknown[] = [],
  kinds: readonly ('select' | 'write')[] = ['select', 'write'],
): void {
  const prefix = pluginTablePrefix(pluginName);
  if (typeof statement !== 'string' || statement.trim() === '') {
    throw new PluginSqlError('The statement is empty.');
  }
  if (statement.length > MAX_STATEMENT_LENGTH) throw new PluginSqlError('The statement is too long.');
  if (/['"`[\]\\]/.test(statement)) {
    throw new PluginSqlError(
      'Quotes, brackets and backslashes are not allowed: pass values as ? parameters and use plain table names.',
    );
  }
  if (statement.includes('--') || statement.includes('/*') || statement.includes('*/')) {
    throw new PluginSqlError('Comments are not allowed in a statement.');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(statement)) {
    throw new PluginSqlError('Control characters are not allowed in a statement.');
  }
  const text = statement.trim().replace(/;\s*$/, '');
  if (text.includes(';')) throw new PluginSqlError('Only one statement can be run at a time.');
  if (values.length > MAX_VALUES) throw new PluginSqlError('Too many values.');
  const placeholders = (text.match(/\?/g) ?? []).length;
  if (placeholders !== values.length) {
    throw new PluginSqlError(
      `The statement has ${placeholders} placeholder(s) but ${values.length} value(s) were given.`,
    );
  }

  const first = /^[a-z]+/i.exec(text)?.[0]?.toLowerCase();
  const kind = first === 'select' ? 'select' : first && ['insert', 'update', 'delete'].includes(first) ? 'write' : null;
  if (!kind) throw new PluginSqlError('Only SELECT, INSERT, UPDATE and DELETE statements are allowed.');
  if (!kinds.includes(kind)) {
    throw new PluginSqlError(
      kind === 'write'
        ? 'Use execute() for INSERT, UPDATE and DELETE.'
        : 'Use query() for a SELECT.',
    );
  }

  // Every name that can follow these words is a table (or a table-valued function, which has no
  // plugin prefix and is refused). `FROM a, b` lists are followed through the commas.
  const tokens = text.split(/(\s+|[(),])/).filter((t) => t.trim() !== '');
  const refused = (name: string): never => {
    throw new PluginSqlError(
      `"${name}" is not one of this plugin's tables: table names must start with "${prefix}".`,
    );
  };
  const checkName = (name: string | undefined) => {
    if (name === undefined || name === '(' || name === ')' || name === ',') return;
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) return refused(name);
    if (!name.toLowerCase().startsWith(prefix.toLowerCase()) || name.length === prefix.length) {
      refused(name);
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!.toLowerCase();
    // `ON CONFLICT … DO UPDATE SET` and `SELECT … FOR UPDATE` use the word without naming a table.
    const before = tokens[i - 1]?.toLowerCase();
    if (word === 'update' && (before === 'do' || before === 'for')) continue;
    if (word === 'from' || word === 'join' || word === 'into' || word === 'update') {
      // A subquery after FROM starts with "(": its own FROM is checked when reached.
      if (tokens[i + 1] === '(') continue;
      checkName(tokens[i + 1]);
      if (word === 'from') {
        // FROM a [alias] , b ...
        let j = i + 2;
        while (j < tokens.length) {
          if (tokens[j] === ',') {
            if (tokens[j + 1] !== '(') checkName(tokens[j + 1]);
            j += 2;
          } else if (
            ['where', 'group', 'order', 'limit', 'having', 'union', 'join', 'left', 'right', 'inner', 'cross', 'on', ')'].includes(
              tokens[j]!.toLowerCase(),
            )
          ) {
            break;
          } else {
            j++;
          }
        }
      }
    }
  }
  // Names that read other schemas or system objects are never one of the plugin's tables.
  if (/\b(pragma|attach|detach|vacuum|create|alter|drop|truncate|grant|revoke)\b/i.test(text)) {
    throw new PluginSqlError('That keyword is not allowed in a statement.');
  }
  if (/\b(sqlite_|pg_|information_schema)/i.test(text)) {
    throw new PluginSqlError('System tables are not available.');
  }
}

/** A `PluginDatabase` for one plugin on top of the site's runner. */
export function createPluginDatabase(
  pluginName: string,
  runner: ParameterizedSqlRunner,
): PluginDatabase {
  return {
    prefix: pluginTablePrefix(pluginName),
    async query(statement, values = []) {
      checkPluginSql(pluginName, statement, values, ['select']);
      return runner.query(statement, values);
    },
    async execute(statement, values = []) {
      checkPluginSql(pluginName, statement, values, ['write']);
      await runner.execute(statement, values);
    },
  };
}
