import type { TemplateProps } from '@nodepress/core';
import { customCss } from './layout.js';

/**
 * The stylesheet for the customizer's settings. It is not a page: the server calls it with the
 * theme's settings and serves the result as a file (`page.settingsCssUrl`), because the default
 * Content-Security-Policy blocks inline `<style>` tags.
 */
export default function style(page: Pick<TemplateProps, 'settings'>): string {
  return customCss(page.settings);
}
