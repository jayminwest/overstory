# Browser Verification

Overstory supports browser-based UI verification through the `verifier` agent capability, powered by [agent-browser](https://github.com/vercel-labs/agent-browser).

## Installation

```bash
npm install -g agent-browser
agent-browser install
```

Verify installation:

```bash
agent-browser --version  # Should be >= 0.9.0
ov doctor --category dependencies  # Should show agent-browser as "pass"
```

## Configuration

Add a `verification` section to your `.overstory/config.yaml`:

```yaml
project:
  name: my-app
  canonicalBranch: main
  verification:
    devServerCommand: "bun run dev"
    baseUrl: "http://localhost:3000"
    port: 3000
    routes:
      - "/"
      - "/login"
      - "/dashboard"
    viewports:
      - "1280x720"
      - "375x812"
```

### Configuration Fields

| Field | Default | Description |
|-------|---------|-------------|
| `devServerCommand` | *(none)* | Command to start the dev server |
| `baseUrl` | `http://localhost:3000` | URL the dev server listens on |
| `port` | `3000` | Dev server port |
| `routes` | `["/"]` | Routes for the verifier to check |
| `viewports` | `["1280x720"]` | Viewport sizes to test |

## How It Works

### Verifier Agent Workflow

When a lead agent receives `worker_done` from a builder and the project has `verification` config, the lead checks if the builder touched frontend files (`.tsx`, `.jsx`, `.html`, `.css`, `.svelte`, `.vue`, or files in `src/app/`, `src/pages/`, `src/components/`, `public/`, `static/`).

If frontend files were modified, the lead spawns a **verifier agent** alongside the reviewer:

1. Verifier reads the task spec and builder diff
2. Starts the dev server in the background
3. Opens the app with `agent-browser open <url> --session $OVERSTORY_AGENT_NAME`
4. Takes an accessibility snapshot to identify interactive elements
5. Exercises UI flows from the spec using ref-based selectors (`@e1`, `@e2`)
6. Takes screenshots at each step as evidence
7. Reports structured PASS/FAIL per acceptance criterion
8. Closes browser and kills dev server

The lead requires BOTH reviewer PASS and verifier PASS before sending `merge_ready`.

### Agent Isolation

Every verifier uses `--session $OVERSTORY_AGENT_NAME` on all agent-browser commands. This ensures concurrent verifiers don't interfere with each other's browser sessions.

## Lightweight Quality Gate (Without Full Agent)

You can use agent-browser as a quality gate without spawning a verifier agent. Add a `browser-smoke` quality gate to your config:

```yaml
project:
  qualityGates:
    - name: "test"
      command: "bun test"
      description: "all tests must pass"
    - name: "lint"
      command: "bun run lint"
      description: "zero errors"
    - name: "typecheck"
      command: "bun run typecheck"
      description: "no TypeScript errors"
    - name: "browser-smoke"
      command: "bash -c 'bun run dev & sleep 5 && agent-browser open http://localhost:3000 && agent-browser snapshot -i --json > /dev/null && agent-browser screenshot /tmp/smoke.png && agent-browser close && kill %1'"
      description: "verify frontend renders and has interactive elements"
```

This runs a quick smoke test: start the dev server, verify the page loads, check that interactive elements exist, take a screenshot, and clean up. No AI judgment — purely mechanical verification.

## Agent-Browser CLI Reference

Key commands used by verifier agents:

```bash
# Open a page in a new browser session
agent-browser open http://localhost:3000 --session my-agent

# Get accessibility tree (interactive elements only)
agent-browser --session my-agent snapshot -i --json

# Click an element by ref
agent-browser --session my-agent click @e2

# Fill a text input
agent-browser --session my-agent fill @e3 "test input"

# Wait for text to appear
agent-browser --session my-agent wait --text "Success"

# Wait for URL navigation
agent-browser --session my-agent wait --url "**/dashboard"

# Take a screenshot
agent-browser --session my-agent screenshot /tmp/verify.png

# Get text content of an element
agent-browser --session my-agent get text @e5

# Check element visibility
agent-browser --session my-agent is visible @e7

# Close browser session
agent-browser --session my-agent close
```

All commands support `--json` for machine-readable output.
