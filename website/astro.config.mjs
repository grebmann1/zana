// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// Two deploy targets share this config:
//   - Heroku (Docker → nginx) at https://zana.dev — the default
//   - GHE Pages at https://git.soma.salesforce.com/pages/chatbots/zana/
//     selected by `DEPLOY_TARGET=ghe-pages` (set in the Actions workflow).
//     Note: GHE serves project pages from /pages/<owner>/<repo>/ — the host
//     itself does not get a `pages.` subdomain like github.io.
const isGhePages = process.env.DEPLOY_TARGET === 'ghe-pages';

export default defineConfig({
  site: isGhePages ? 'https://git.soma.salesforce.com' : 'https://zana.dev',
  base: isGhePages ? '/pages/chatbots/zana' : undefined,
  output: 'static',
  trailingSlash: 'always',
  integrations: [tailwind({ applyBaseStyles: false }), mdx(), sitemap()],
  build: {
    inlineStylesheets: 'auto',
    format: 'directory',
  },
});
