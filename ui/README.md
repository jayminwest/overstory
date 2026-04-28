# Overstory UI

React SPA frontend for `ov serve`.

## Development

```bash
bun install
bun run dev
```

Starts Vite dev server on port 5173. Proxies `/api` and `/ws` to
`OVERSTORY_SERVE_URL` (default: `http://localhost:8080`).

## Build

```bash
bun run build
```

Outputs to `ui/dist/`. The `ov serve` command serves this bundle.
