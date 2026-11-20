import type { TemplateProps } from '@nodepress/core';
import Single from './single.js';
import NotFound from './404.js';

/** The last template in every hierarchy: draws whatever has no more specific template. */
export default function Index(page: TemplateProps) {
  return page.status === 404 ? NotFound(page) : Single(page);
}
