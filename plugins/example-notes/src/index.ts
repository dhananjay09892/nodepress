import {
  definePlugin,
  type PluginDatabase,
  type PluginRouteHandler,
  type PluginRouteRequest,
} from '@nodepress/sdk';

/** The longest note, in characters. */
export const MAX_NOTE_LENGTH = 500;

/** Check the JSON body of a "new note" request: `{ "body": "text" }`. */
export function parseNote(input: unknown): { ok: true; body: string } | { ok: false; message: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'Send a JSON object like {"body": "text"}.' };
  }
  const body = (input as Record<string, unknown>)['body'];
  if (typeof body !== 'string' || body.trim() === '') {
    return { ok: false, message: 'body must be some text.' };
  }
  if (body.length > MAX_NOTE_LENGTH) {
    return { ok: false, message: `body is limited to ${MAX_NOTE_LENGTH} characters.` };
  }
  return { ok: true, body: body.trim() };
}

/** The signed-in user. Routes below need a capability, so the server has checked it is set. */
function owner(request: PluginRouteRequest): number {
  return request.user!.id;
}

/** The three route handlers, on top of the plugin's database access. */
export function createHandlers(db: PluginDatabase) {
  const list: PluginRouteHandler = async (request) => {
    const rows = await db.query(
      'SELECT id, body, created_at FROM example_notes_items WHERE owner_id = ? ORDER BY id DESC LIMIT ?',
      [owner(request), 100],
    );
    return { json: { notes: rows } };
  };

  const create: PluginRouteHandler = async (request) => {
    const note = parseNote(await request.json());
    if (!note.ok) return { status: 400, json: { error: 'invalid_request', message: note.message } };
    await db.execute('INSERT INTO example_notes_items (owner_id, body, created_at) VALUES (?, ?, ?)', [
      owner(request),
      note.body,
      new Date().toISOString(),
    ]);
    return { status: 201, json: { ok: true } };
  };

  const remove: PluginRouteHandler = async (request) => {
    const id = Number(request.params['id']);
    if (!Number.isInteger(id)) return { status: 400, json: { error: 'invalid_request' } };
    // Only the owner's own notes match, so another user's id changes nothing.
    await db.execute('DELETE FROM example_notes_items WHERE id = ? AND owner_id = ?', [
      id,
      owner(request),
    ]);
    return { status: 204 };
  };

  return { list, create, remove };
}

export default definePlugin({
  name: 'example-notes',
  version: '0.1.0',
  description: 'Private notes for editors: HTTP routes, a database table and a migration',
  setup({ routes, db, logger }) {
    if (!db) {
      logger.warn('example-notes needs the "database" permission in plugin.json');
      return;
    }
    const handlers = createHandlers(db);
    // `edit_posts` is held by authors, editors and administrators; the server answers 401 or 403
    // before these handlers run.
    routes.add({ method: 'GET', path: '/notes', capability: 'edit_posts', handler: handlers.list });
    routes.add({ method: 'POST', path: '/notes', capability: 'edit_posts', handler: handlers.create });
    routes.add({
      method: 'DELETE',
      path: '/notes/:id',
      capability: 'edit_posts',
      handler: handlers.remove,
    });
  },
});
