// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// Two deploy targets share this config:
//   - Heroku (Docker → nginx) at https://zana.dev — the default
//   - GHE Pages at https://pages.git.soma.salesforce.com/chatbots/zana/
//     selected by `DEPLOY_TARGET=ghe-pages` (set in the Actions workflow)
const isGhePages = process.env.DEPLOY_TARGET === 'ghe-pages';

export default defineConfig({
  site: isGhePages ? 'https://pages.git.soma.salesforce.com' : 'https://zana.dev',
  base: isGhePages ? '/chatbots/zana' : undefined,
  output: 'static',
  trailingSlash: 'always',
  integrations: [tailwind({ applyBaseStyles: false }), mdx(), sitemap()],
  build: {
    inlineStylesheets: 'auto',
    format: 'directory',
  },
});
