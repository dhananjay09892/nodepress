import { definePlugin, type Content, type MetaTags, type PluginContext } from '@nodepress/sdk';

/** Settings saved on the plugin's admin page (panel `general`). */
export interface SeoSettings {
  /** Ask search engines to leave the whole site out (`noindex, nofollow`). */
  noindexSite: boolean;
  /** Social image used when a post or page has none of its own (a path or an http(s) URL). */
  defaultSocialImage: string;
  /** Name of the publisher in the structured data. */
  organizationName: string;
  /** Add schema.org JSON-LD to pages. */
  schemaEnabled: boolean;
}

export const DEFAULT_SETTINGS: SeoSettings = {
  noindexSite: false,
  defaultSocialImage: '',
  organizationName: '',
  schemaEnabled: true,
};

/** Names of the custom fields the plugin adds to posts and pages. */
export const FIELDS = {
  title: 'seo_title',
  description: 'seo_description',
  image: 'seo_image',
  noindex: 'seo_noindex',
} as const;

export interface SeoContext {
  status: 200 | 404;
  content?: Content | undefined;
  fields?: Record<string, unknown> | undefined;
}

/** Read the values saved by the settings panel, with defaults for anything missing or odd. */
export function readSettings(values: Record<string, unknown>): SeoSettings {
  return {
    noindexSite: values.noindex_site === true,
    defaultSocialImage:
      typeof values.default_social_image === 'string' ? values.default_social_image.trim() : '',
    organizationName:
      typeof values.organization_name === 'string' ? values.organization_name.trim() : '',
    schemaEnabled: values.schema_enabled !== false,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** An absolute http(s) URL for a path or URL, resolved against the page's address; else undefined. */
export function absoluteImage(value: string, pageUrl: string | undefined): string | undefined {
  if (!value || value.startsWith('//')) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function jsonLd(
  meta: MetaTags,
  context: SeoContext,
  settings: SeoSettings,
  headline: string,
): Array<Record<string, unknown>> {
  if (!settings.schemaEnabled || context.status === 404) return [];
  const url = meta.canonical;
  const publisher = settings.organizationName
    ? { '@type': 'Organization', name: settings.organizationName }
    : undefined;
  const base = { '@context': 'https://schema.org' };
  const { content } = context;
  if (!content) {
    return [
      {
        ...base,
        '@type': 'WebSite',
        name: meta.og.siteName,
        ...(url ? { url } : {}),
        ...(meta.description ? { description: meta.description } : {}),
      },
      ...(publisher ? [{ ...base, ...publisher, ...(url ? { url } : {}) }] : []),
    ];
  }
  const common = {
    ...base,
    description: meta.description,
    ...(url ? { url, mainEntityOfPage: url } : {}),
    ...(meta.og.image ? { image: [meta.og.image] } : {}),
  };
  if (content.type === 'post') {
    return [
      {
        ...common,
        '@type': 'Article',
        headline,
        datePublished: (content.publishedAt ?? content.createdAt).toISOString(),
        dateModified: content.updatedAt.toISOString(),
        ...(publisher ? { publisher } : {}),
      },
    ];
  }
  const { mainEntityOfPage: _unused, ...page } = common as Record<string, unknown>;
  void _unused;
  return [{ ...page, '@type': 'WebPage', name: headline }];
}

/**
 * Apply the plugin's per-item fields and site settings to a page's SEO tags: title, description,
 * social image, robots and JSON-LD. Pure, so it is easy to test.
 */
export function applySeo(meta: MetaTags, context: SeoContext, settings: SeoSettings): MetaTags {
  const fields = context.fields ?? {};
  const customTitle = text(fields[FIELDS.title]);
  const customDescription = text(fields[FIELDS.description]);
  const image =
    absoluteImage(text(fields[FIELDS.image]), meta.canonical) ??
    absoluteImage(settings.defaultSocialImage, meta.canonical) ??
    meta.og.image;

  const description = customDescription || meta.description;
  const ogTitle = customTitle || meta.og.title;
  const out: MetaTags = {
    ...meta,
    description,
    ...(customTitle ? { title: `${customTitle} | ${meta.og.siteName}` } : {}),
    og: {
      ...meta.og,
      title: ogTitle,
      description: customDescription || meta.og.description,
      ...(image ? { image } : {}),
    },
  };

  if (context.status === 404) out.robots = 'noindex';
  else if (settings.noindexSite) out.robots = 'noindex, nofollow';
  else if (fields[FIELDS.noindex] === true) out.robots = 'noindex, follow';

  const data = jsonLd(out, context, settings, ogTitle);
  if (data.length > 0) out.jsonLd = [...(meta.jsonLd ?? []), ...data];
  return out;
}

const CONTENT_TYPES = ['post', 'page'];

function setupFields(admin: PluginContext['admin']): void {
  const fields = [
    {
      name: FIELDS.title,
      type: 'text' as const,
      label: 'SEO title',
      description: 'Shown in search results and browser tabs instead of the post title.',
      maxLength: 120,
    },
    {
      name: FIELDS.description,
      type: 'text' as const,
      label: 'Meta description',
      description: 'A sentence or two for search results. Leave empty to use the excerpt.',
      maxLength: 300,
    },
    {
      name: FIELDS.image,
      type: 'text' as const,
      label: 'Social image URL',
      description: 'Shown when the page is shared. Leave empty to use the default image.',
      maxLength: 500,
    },
    {
      name: FIELDS.noindex,
      type: 'boolean' as const,
      label: 'Hide from search engines',
    },
  ];
  for (const field of fields) admin.addPostField({ field, contentTypes: CONTENT_TYPES });
}

/**
 * The SEO plugin: per-post title, description, social image and "hide from search engines",
 * site-wide robots and default image settings, and schema.org JSON-LD. It works through the
 * `meta:tags` filter, so any theme that draws NodePress's `meta` prop shows the result.
 */
export default definePlugin({
  name: 'seo',
  version: '0.0.0',
  description: 'Meta title and description, social image, robots settings and schema.org data',
  setup({ hooks, logger, admin }) {
    admin.addPage({
      id: 'settings',
      title: 'SEO settings',
      description: 'Defaults for search engines and social sharing.',
      panels: [
        {
          id: 'general',
          title: 'General',
          fields: [
            {
              name: 'noindex_site',
              type: 'boolean',
              label: 'Ask search engines not to index this site',
              description: 'Adds a noindex, nofollow robots tag to every page. Use it while building.',
              default: false,
            },
            {
              name: 'default_social_image',
              type: 'text',
              label: 'Default social image URL',
              description: 'A path (/uploads/logo.png) or an https address.',
              maxLength: 500,
            },
            {
              name: 'organization_name',
              type: 'text',
              label: 'Organization name',
              description: 'The publisher named in the structured data.',
              maxLength: 120,
            },
            {
              name: 'schema_enabled',
              type: 'boolean',
              label: 'Add schema.org structured data',
              default: true,
            },
          ],
        },
      ],
    });
    admin.addMenuItem({ id: 'seo', label: 'SEO', page: 'settings', order: 80 });
    setupFields(admin);

    hooks.addFilter('meta:tags', async (meta, context) => {
      let settings = DEFAULT_SETTINGS;
      try {
        settings = readSettings(await admin.getSettings('settings', 'general'));
      } catch (error) {
        // Settings are optional: without them the defaults apply.
        logger.warn(`SEO settings could not be read: ${String(error)}`);
      }
      return applySeo(meta, context, settings);
    });
  },
});
