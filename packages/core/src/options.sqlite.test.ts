import { createDatabase, createOptionsStore, type DatabaseHandle } from '@nodepress/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookRegistry } from './hooks.js';
import { createOptionsService, type OptionsService } from './options.js';

declare module './options.js' {
  interface OptionMap {
    'test:site_name': string;
  }
}

let handle: DatabaseHandle;
let hooks: HookRegistry;
let options: OptionsService;

async function open(): Promise<OptionsService> {
  return createOptionsService({ store: createOptionsStore(handle), hooks });
}

beforeEach(async () => {
  handle = createDatabase({ url: ':memory:' });
  await handle.migrate();
  hooks = new HookRegistry();
  options = await open();
});

afterEach(async () => {
  await handle.close();
});

describe('OptionsService on in-memory SQLite', () => {
  it('stores typed values and reads them back', async () => {
    await options.set('test:site_name', 'NodePress');
    const name: string | undefined = await options.get('test:site_name');
    expect(name).toBe('NodePress');
    expect(await options.get('test:site_name', 'fallback')).toBe('NodePress');
  });

  it('persists across service instances (a fresh cache)', async () => {
    await options.set('permalinks', { structure: '/%slug%/' });
    await options.set('lazy', [1, 2, 3], { autoload: false });

    const fresh = await open();
    expect(await fresh.getAutoloaded()).toEqual({ permalinks: { structure: '/%slug%/' } });
    expect(await fresh.get('lazy')).toEqual([1, 2, 3]);
  });

  it('updates in place, fires hooks and deletes', async () => {
    const events: string[] = [];
    hooks.addAction('option:updated', (key, value) => void events.push(`${key}=${String(value)}`));
    await options.set('a', 1);
    await options.set('a', 2);
    expect(events).toEqual(['a=1', 'a=2']);

    expect(await options.delete('a')).toBe(true);
    expect(await (await open()).has('a')).toBe(false);
  });
});
