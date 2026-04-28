# Overstory UI

React SPA frontend for `ov serve`.

## Development

```bash
bun install
bun run dev
```

Starts Bun's native dev server (with HMR) on port 3000. Tailwind v4 is
processed via `bun-plugin-tailwind` (configured in `bunfig.toml`).

## Build

```bash
bun run build
```

Outputs a static bundle to `ui/dist/`. The `ov serve` command serves this bundle.
