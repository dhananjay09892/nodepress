import { describe, expect, it } from 'vitest';
import { parseArgs, textFlag, UsageError } from './args.js';

describe('parseArgs', () => {
  it('splits words from flags', () => {
    expect(parseArgs(['plugin', 'create', 'my-plugin', '--dir', 'x', '--force'])).toEqual({
      positional: ['plugin', 'create', 'my-plugin'],
      flags: { dir: 'x', force: true },
    });
  });

  it('accepts --name=value, even with dashes and equals signs in the value', () => {
    expect(parseArgs(['--title=A=B', '--database-url=postgres://u:p@h/db']).flags).toEqual({
      title: 'A=B',
      'database-url': 'postgres://u:p@h/db',
    });
  });

  it('keeps the argument after a boolean flag', () => {
    expect(parseArgs(['plugin', 'create', '--force', 'my-plugin']).positional).toEqual([
      'plugin',
      'create',
      'my-plugin',
    ]);
  });

  it('treats a flag followed by another flag, or by nothing, as true', () => {
    expect(parseArgs(['--out', '--dir']).flags).toEqual({ out: true, dir: true });
    expect(parseArgs(['--out']).flags).toEqual({ out: true });
  });

  it('maps -h to help and stops at --', () => {
    expect(parseArgs(['-h']).flags).toEqual({ help: true });
    expect(parseArgs(['a', '--', '--not-a-flag']).positional).toEqual(['a', '--not-a-flag']);
  });
});

describe('textFlag', () => {
  it('returns text, undefined when absent and throws for a bare flag', () => {
    expect(textFlag(parseArgs(['--dir', 'x']), 'dir')).toBe('x');
    expect(textFlag(parseArgs([]), 'dir')).toBeUndefined();
    expect(() => textFlag(parseArgs(['--dir']), 'dir')).toThrow(UsageError);
  });
});
