import { readFileSync } from 'node:fs';
import { HookRegistry, PluginManager, silentLogger } from '@nodepress/core';
import { createDatabase, createParameterizedRunner, type DatabaseHandle } from '@nodepress/db';
import examplePlugin, { MAX_NOTE_LENGTH, parseNote } from '@nodepress/plugin-example-notes';
import { afterEach, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../plugins/example-notes/migrations/sqlite/0001_create_notes.sql',
  import.meta.url,
);

const open: DatabaseHandle[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function boot() {
  const database = createDatabase({ url: ':memory:' });
  open.push(database);
  const runner = createParameterizedRunner(database);
  for (const statement of readFileSync(migrationUrl, 'utf8').split('-- statement-breakpoint')) {
    await runner.execute(statement.trim(), []);
  }
  const manager = new PluginManager(new HookRegistry(), silentLogger, {});
  manager.useDatabase(runner);
  manager.register(examplePlugin, { permissions: ['database'] });
  await manager.activateAll();
  return manager;
}

const user = (id: number) => ({ id, email: `u${id}@example.com`, role: 'editor' });

function call(
  manager: PluginManager,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  userId: number,
  body?: unknown,
) {
  const matched = manager.routes.match('example-notes', method, path);
  if (!matched) throw new Error(`no route ${method} ${path}`);
  return matched.definition.handler({
    method,
    path,
    params: matched.params,
    query: {},
    headers: {},
    user: user(userId),
    json: async () => body,
  });
}

describe('the example-notes plugin', () => {
  it('registers three routes that need edit_posts', async () => {
    const manager = await boot();
    expect(manager.routes.list('example-notes')).toEqual([
      { source: 'example-notes', method: 'GET', path: '/notes', capability: 'edit_posts' },
      { source: 'example-notes', method: 'POST', path: '/notes', capability: 'edit_posts' },
      { source: 'example-notes', method: 'DELETE', path: '/notes/:id', capability: 'edit_posts' },
    ]);
  });

  it('adds and lists a note, newest first, per user', async () => {
    const manager = await boot();
    expect((await call(manager, 'POST', '/notes', 1, { body: ' first ' })).status).toBe(201);
    await call(manager, 'POST', '/notes', 1, { body: 'second' });
    await call(manager, 'POST', '/notes', 2, { body: 'someone else' });
    const mine = (await call(manager, 'GET', '/notes', 1)).json as { notes: { body: string }[] };
    expect(mine.notes.map((n) => n.body)).toEqual(['second', 'first']);
  });

  it('rejects a bad body with 400', async () => {
    const manager = await boot();
    const response = await call(manager, 'POST', '/notes', 1, { body: '  ' });
    expect(response.status).toBe(400);
  });

  it('only deletes the caller own notes', async () => {
    const manager = await boot();
    await call(manager, 'POST', '/notes', 1, { body: 'keep me' });
    const listed = (await call(manager, 'GET', '/notes', 1)).json as { notes: { id: number }[] };
    const id = listed.notes[0]!.id;
    expect((await call(manager, 'DELETE', `/notes/${id}`, 2)).status).toBe(204);
    expect(
      ((await call(manager, 'GET', '/notes', 1)).json as { notes: unknown[] }).notes,
    ).toHaveLength(1);
    await call(manager, 'DELETE', `/notes/${id}`, 1);
    expect(
      ((await call(manager, 'GET', '/notes', 1)).json as { notes: unknown[] }).notes,
    ).toHaveLength(0);
  });

  it('adds no routes without the database permission', async () => {
    const manager = new PluginManager(new HookRegistry(), silentLogger, {});
    manager.register(examplePlugin);
    await manager.activateAll();
    expect(manager.routes.list('example-notes')).toEqual([]);
  });
});

describe('parseNote', () => {
  it('accepts text and limits the length', () => {
    expect(parseNote({ body: 'hi' })).toEqual({ ok: true, body: 'hi' });
    expect(parseNote({ body: 'x'.repeat(MAX_NOTE_LENGTH + 1) }).ok).toBe(false);
    expect(parseNote(null).ok).toBe(false);
    expect(parseNote([]).ok).toBe(false);
    expect(parseNote({ body: 5 }).ok).toBe(false);
  });
});
