import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [
    starlight({
      title: 'NodePress',
      description: 'Documentation for NodePress, a WordPress-style CMS on TypeScript.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/dhananjay09892/nodepress' },
      ],
      sidebar: [
        {
          label: 'Guides',
          items: [
            { label: 'Getting started', slug: 'guides/getting-started' },
            { label: 'Write a plugin', slug: 'guides/plugins' },
            { label: 'Build a theme', slug: 'guides/themes' },
          ],
        },
        { label: 'Reference', items: [{ label: 'Hooks', slug: 'reference/hooks' }] },
      ],
    }),
  ],
});
