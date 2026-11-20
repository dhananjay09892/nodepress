import { describe, expect, it } from 'vitest';
import { extractHooks, renderHooksReference } from './hooks-reference.js';

const source = `
declare module './hooks.js' {
  interface ActionMap {
    'session:created': [info: { userId: number }];
    /** A content type was registered. */
    'content-type:registered': [type: RegisteredContentType];
  }
  interface FilterMap {
    /**
     * Final say on a capability check.
     * Return a boolean to override.
     */
    'user:can': { value: boolean; context: { user: CapabilityUser; capability: string } };
    // a plain comment is ignored
    'x:y': { value: string; context: undefined };
  }
}
interface Other { 'not:hook': string; }
`;

describe('extractHooks', () => {
  const hooks = extractHooks(source, 'packages/core/src/a.ts');

  it('finds actions and filters with their types', () => {
    expect(hooks.map((h) => `${h.kind}:${h.name}`)).toEqual([
      'action:session:created',
      'action:content-type:registered',
      'filter:user:can',
      'filter:x:y',
    ]);
    expect(hooks[0]?.signature).toBe('[info: { userId: number }]');
    expect(hooks[2]?.signature).toBe(
      '{ value: boolean; context: { user: CapabilityUser; capability: string } }',
    );
  });

  it('keeps the doc comment of an entry and not of its neighbours', () => {
    expect(hooks[0]?.description).toBe('');
    expect(hooks[1]?.description).toBe('A content type was registered.');
    expect(hooks[2]?.description).toBe(
      'Final say on a capability check. Return a boolean to override.',
    );
    expect(hooks[3]?.description).toBe('');
  });

  it('ignores other interfaces', () => {
    expect(hooks.some((h) => h.name === 'not:hook')).toBe(false);
  });
});

describe('renderHooksReference', () => {
  it('writes front matter, counts and a section per hook, sorted by name', () => {
    const page = renderHooksReference(extractHooks(source, 'f.ts'));
    expect(page.startsWith('---\ntitle: Hooks reference')).toBe(true);
    expect(page).toContain('## Actions (2)');
    expect(page).toContain('## Filters (2)');
    expect(page.indexOf('content-type:registered')).toBeLessThan(page.indexOf('session:created'));
    expect(page).toContain('Declared in `f.ts`.');
  });
});
