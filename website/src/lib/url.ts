// Base-aware URL helpers. Astro exposes import.meta.env.BASE_URL with a
// trailing slash — "/" by default, "/chatbots/zana/" under GHE Pages.
//
//   link("/docs/")       → "/docs/"            (default)
//                        → "/chatbots/zana/docs/" (GHE)
//
//   stripBase("/chatbots/zana/docs/")
//                        → "/docs/"            (use for active-link matching)

const BASE = import.meta.env.BASE_URL;            // always ends in "/"
const BASE_NO_TRAILING = BASE.replace(/\/$/, ""); // "" or "/chatbots/zana"

export function link(path: string): string {
  if (!path.startsWith("/")) return path; // pass through external + relative
  return `${BASE_NO_TRAILING}${path}`;
}

export function stripBase(pathname: string): string {
  if (!BASE_NO_TRAILING) return pathname;
  return pathname.startsWith(BASE_NO_TRAILING)
    ? pathname.slice(BASE_NO_TRAILING.length) || "/"
    : pathname;
}
