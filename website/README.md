# Zana — Marketing Website

Welcome / landing site for the Zana agent orchestrator.

## Stack

- Astro 5 + Tailwind 3 + MDX (static output)
- Multi-stage Docker (node 20 build → nginx 1.27 alpine serve)
- Heroku-ready via container stack

## Local development

```bash
cd website
npm install
npm run dev    # http://localhost:4321
```

## Production build

```bash
npm run build  # outputs ./dist
npm run preview
```

## Docker

```bash
# build & run locally
docker compose up --build         # http://localhost:8080

# Heroku-style port test
docker build -t zana-website .
docker run --rm -e PORT=3000 -p 3000:3000 zana-website
```

## Deploy to Heroku

```bash
heroku create zana-website
heroku stack:set container -a zana-website
git subtree push --prefix website heroku main
```

The `heroku.yml` declares the Dockerfile build; `nginx.conf.template` is
runtime-substituted with `$PORT` by `docker-entrypoint.sh`.

## Project structure

```
website/
├── Dockerfile              multi-stage build
├── nginx.conf.template     ${PORT}-aware nginx config
├── docker-entrypoint.sh    envsubst at container start
├── docker-compose.yml      local container preview (8080:80)
├── heroku.yml              container deploy declaration
├── astro.config.mjs        static output, integrations
├── tailwind.config.mjs     brand palette + animations
├── public/
│   └── favicon.svg
└── src/
    ├── layouts/BaseLayout.astro
    ├── components/         Header, Footer, Hero, etc.
    │   └── illustrations/  Fairy, RuneCircle, DandelionSeeds (inline SVG)
    ├── pages/
    │   ├── index.astro     home
    │   ├── how-it-works.astro
    │   ├── features.astro
    │   ├── about.astro
    │   └── docs/index.astro
    └── styles/global.css
```

## Brand

| Token        | Value     | Use                      |
|--------------|-----------|--------------------------|
| cream        | `#FAF6E8` | page background          |
| parchment    | `#F3EBD3` | section bands            |
| forest       | `#2D5F3F` | primary text + headings  |
| moss         | `#4A7856` | secondary text           |
| gold         | `#C9A961` | accents, CTAs            |
| berry        | `#8B3A4E` | hover/active             |
| ink          | `#1F2A24` | body emphasis            |

Display: Fraunces · Body: Inter · Mono: JetBrains Mono.
