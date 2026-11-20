export interface ParsedArgs {
  /** Words before any flag: `["plugin", "create", "my-plugin"]`. */
  positional: string[];
  /** `--name value` and `--name=value` become strings; a bare `--flag` becomes `true`. */
  flags: Record<string, string | true>;
}

/** Flags that never take a value, so `--force my-plugin` keeps `my-plugin` as an argument. */
const BOOLEAN_FLAGS = new Set(['help', 'force', 'version']);

/** A small argument parser: no abbreviations, no surprises. `--` ends the flags. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      flags['help'] = true;
    } else if (arg.startsWith('--') && arg.length > 2) {
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
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** A flag that must be text; `undefined` when absent. Throws for a bare `--flag`. */
export function textFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${name} needs a value`);
  return value;
}

/** A mistake in how the command was typed. Printed with the help hint, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
