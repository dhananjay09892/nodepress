---
title: Hooks reference
description: Every action and filter NodePress core and the bundled plugins declare.
---

This page is generated from the `ActionMap` and `FilterMap` declarations in the source, so it always matches the code.

An **action** announces that something happened; listeners receive the arguments shown. A **filter** passes a `value` through every listener; each returns the new value, and `context` is read-only extra information.

## Actions (31)

### `apitoken:created`

```ts
[info: { userId: number; tokenId: number }]
```

Declared in `packages/core/src/api-tokens.ts`.

### `apitoken:revoked`

```ts
[info: { userId: number; tokenId: number }]
```

Declared in `packages/core/src/api-tokens.ts`.

### `content-type:registered`

A content type was registered (or re-registered on refresh).

```ts
[type: RegisteredContentType]
```

Declared in `packages/core/src/content-types.ts`.

### `content:terms-changed`

The terms of one taxonomy on an item changed. `termIds` is the full set now assigned.

```ts
[ info: { contentId: number; taxonomy: string; termIds: number[]; added: number[]; removed: number[]; }, ]
```

Declared in `packages/core/src/taxonomies.ts`.

### `core:boot`

Core is starting; plugins are not yet active.

```ts
[]
```

Declared in `packages/core/src/kernel.ts`.

### `core:ready`

All plugins are active and the site is ready to serve requests.

```ts
[]
```

Declared in `packages/core/src/kernel.ts`.

### `core:shutdown`

The site is shutting down; plugins are still active.

```ts
[]
```

Declared in `packages/core/src/kernel.ts`.

### `job:completed`

A job handler finished without throwing.

```ts
[job: Job]
```

Declared in `packages/core/src/jobs.ts`.

### `job:failed`

A job used up its attempts (or was abandoned) and is now recorded as failed.

```ts
[job: Job, info: { error: string }]
```

Declared in `packages/core/src/jobs.ts`.

### `job:retry`

A job handler threw or timed out and the job will run again at `runAt`.

```ts
[job: Job, info: { error: string; runAt: Date }]
```

Declared in `packages/core/src/jobs.ts`.

### `media:deleted`

```ts
[media: MediaRecord]
```

Declared in `packages/core/src/media.ts`.

### `media:uploaded`

```ts
[media: MediaRecord]
```

Declared in `packages/core/src/media.ts`.

### `option:deleted`

An option was deleted.

```ts
[key: string, oldValue: unknown]
```

Declared in `packages/core/src/options.ts`.

### `option:updated`

An option was created or changed. `oldValue` is `undefined` for a new option.

```ts
[key: string, newValue: unknown, oldValue: unknown]
```

Declared in `packages/core/src/options.ts`.

### `plugin:activated`

```ts
[info: { name: string }]
```

Declared in `packages/core/src/kernel.ts`.

### `plugin:deactivated`

```ts
[info: { name: string }]
```

Declared in `packages/core/src/kernel.ts`.

### `plugin:error`

```ts
[info: { name: string; error: unknown }]
```

Declared in `packages/core/src/kernel.ts`.

### `post:deleted`

```ts
[content: Content]
```

Declared in `packages/core/src/content.ts`.

### `post:published`

When an item becomes published (created as published, or moved to published).

```ts
[content: Content]
```

Declared in `packages/core/src/content.ts`.

### `post:saved`

After every successful create or update.

```ts
[content: Content, info: { isNew: boolean; previous?: Content }]
```

Declared in `packages/core/src/content.ts`.

### `post:trashed`

```ts
[content: Content]
```

Declared in `packages/core/src/content.ts`.

### `session:created`

```ts
[info: { userId: number }]
```

Declared in `packages/core/src/sessions.ts`.

### `session:destroyed`

```ts
[info: { userId: number }]
```

Declared in `packages/core/src/sessions.ts`.

### `shop:order-paid`

```ts
[order: Order]
```

Declared in `packages/core/src/hooks.ts`.

### `taxonomy:registered`

A taxonomy was registered (or re-registered on refresh).

```ts
[taxonomy: RegisteredTaxonomy]
```

Declared in `packages/core/src/taxonomies.ts`.

### `term:created`

```ts
[term: Term]
```

Declared in `packages/core/src/taxonomies.ts`.

### `term:deleted`

```ts
[term: Term]
```

Declared in `packages/core/src/taxonomies.ts`.

### `term:updated`

```ts
[term: Term, previous: Term]
```

Declared in `packages/core/src/taxonomies.ts`.

### `user:created`

```ts
[user: User]
```

Declared in `packages/core/src/users.ts`.

### `user:deleted`

```ts
[user: User]
```

Declared in `packages/core/src/users.ts`.

### `user:updated`

```ts
[user: User, previous: User]
```

Declared in `packages/core/src/users.ts`.

## Filters (14)

### `api:response`

The JSON body of a successful content API response, just before it is sent. Return an object to replace it; anything else is ignored. `route` is one of `content-types:list`, `content:list`, `content:get`, `content:create`, `content:update`, `content:trash` or `content:revisions`.

```ts
{ value: unknown; /** `user` is `null` for an anonymous read of published content (see `api_public_read`). */ context: { route: string; method: string; status: number; user: User | null }; }
```

Declared in `apps/server/src/content-api.ts`.

### `content-type:definitions`

Plugins add content types by appending definitions to the list. Invalid definitions are logged and skipped; they never stop other types from registering.

```ts
{ value: ContentTypeDefinition[]; context: undefined }
```

Declared in `packages/core/src/content-types.ts`.

### `content-type:fields`

Plugins add custom fields to any content type, built-in ones included (for example a subtitle on every post) by appending field definitions to the list. The `type` in the context is the content type being refreshed. A field that is invalid, or whose name is already taken, is logged and skipped; it never stops other fields from registering.

```ts
{ value: FieldDefinition[]; context: { type: string } }
```

Declared in `packages/core/src/content-types.ts`.

### `media:allowed-types`

MIME types the media library accepts. Plugins can remove types (for example to forbid PDFs); types the core cannot recognise from their content are ignored if added.

```ts
{ value: string[]; context: undefined }
```

Declared in `packages/core/src/media.ts`.

### `meta:tags`

Change the SEO tags of a themed page. A result that is not valid meta tags is ignored.

```ts
{ value: MetaTags; context: MetaTagsContext }
```

Declared in `packages/core/src/themes.ts`.

### `option:value`

Every value returned by `options.get()` (including the fallback) passes through here.

```ts
{ value: unknown; context: { key: string } }
```

Declared in `packages/core/src/options.ts`.

### `permalink:pattern`

The permalink pattern used for a content type. Plugins can give custom types their own pattern. An invalid result is ignored and the built-in pattern is used.

```ts
{ value: string; context: { type: string } }
```

Declared in `packages/core/src/permalinks.ts`.

### `post:saving`

Change the fields about to be saved. The result is re-validated; if a listener returns something invalid the unfiltered fields are saved instead.

```ts
{ value: ContentFields; context: ContentSavingContext }
```

Declared in `packages/core/src/content.ts`.

### `render:html`

Final HTML of a front-end page, just before it is sent.

```ts
{ value: string; context: { path: string } }
```

Declared in `apps/server/src/app.ts`.

### `taxonomy:definitions`

Plugins add taxonomies by appending definitions to the list. Invalid definitions are logged and skipped; they never stop other taxonomies from registering.

```ts
{ value: TaxonomyDefinition[]; context: undefined }
```

Declared in `packages/core/src/taxonomies.ts`.

### `template:resolve`

The template names to try for a page, most specific first (for example `['single-product', 'single', 'index']`). Plugins can add, remove or reorder names. Names the active theme does not have are skipped.

```ts
{ value: string[]; context: { target: TemplateTarget } }
```

Declared in `packages/core/src/themes.ts`.

### `user:can`

Final say on a capability check. `value` is the built-in answer; return a boolean to override it (for example to grant a capability per user).

```ts
{ value: boolean; context: { user: CapabilityUser; capability: string } }
```

Declared in `packages/core/src/capabilities.ts`.

### `user:role-capabilities`

The capability list of a role. Plugins add (or remove) capabilities here; the result is what `can()` uses. Context carries the role name.

```ts
{ value: string[]; context: { role: string } }
```

Declared in `packages/core/src/capabilities.ts`.

### `widget:types`

The widget types plugins add. Return the list with your definitions appended (plugins normally call `context.registerWidget()`, which does this and removes it on deactivation).

```ts
{ value: WidgetTypeDefinition[]; context: undefined }
```

Declared in `packages/core/src/widgets.ts`.
