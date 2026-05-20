// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://zana.dev',
  output: 'static',
  integrations: [tailwind({ applyBaseStyles: false }), mdx(), sitemap()],
  build: { inlineStylesheets: 'auto' },
});
