# @zana-ai/extras

User-facing customization for [Zana](https://github.com/grebmann1/zana)
— settings store, skill store, plugin loader.

## Install

```bash
npm install @zana-ai/extras
```

## Modules

| File | What |
|---|---|
| `settings/store.ts` | User-level settings (`~/.zana/settings.json`) |
| `settings/skill-store.ts` | Backs `zana_list_skills`, `zana_get_skill`, `zana_save_skill`, `zana_toggle_skill` |
| `plugins/loader.ts` | Discovers + loads Zana modules at daemon boot |
| `plugins/scaffold.ts` | Generates module skeletons (`zana module new`) |

## Public surface

```ts
import {
  settingsStore,
  skillStore,
  pluginLoader,
  pluginScaffold,
} from "@zana-ai/extras";
```

## See also

- [`@zana-ai/core`](../core) — the module-registration host
