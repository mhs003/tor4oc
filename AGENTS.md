# AGENTS.md

Notes for agents (and people) working on `tor4oc`.

---

## What this is

An OpenCode server plugin. One Tor tunnel per server process, proxy env injected into every shell command via `ctx.shell.hook("create.before")`, plus four tools under the `tor` namespace.

Read `ARCHITECTURE.md` before changing anything structural. Read `TRACK.md` for what has been verified and what has not.

---

## Environment facts learned the hard way

- **Node built-ins only.** The plugin runs inside the OpenCode server binary. Do not assume `Bun.*`. An initial draft used `Bun.spawn` / `Bun.connect` / `Bun.write` and had to be rewritten to `node:child_process`, `node:net`, `node:fs/promises`.
- **`@opencode/plugin` is the V2 package**, not `@opencode-ai/plugin` (V1). V2 is `2.3.0` as of writing.
- **Typecheck with `./node_modules/.bin/tsc -p tsconfig.json`.** Needs `@types/node` and `typescript` as dev deps. Without `@types/node` every `node:` import errors with `TS2591`.
- **Plugin listings lie.** `/api/plugin` returned `{"data":[]}` and `opencode plugin list` said "No plugins found" while the plugin demonstrably loaded and worked. Never use either to decide whether a plugin loaded.
- **`opencode api` starts a throwaway server per call.** A shell created in one call is `ShellNotFoundError` in the next, and plugins do not load on that path.
- **`opencode acp` is a stdio protocol server.** No port, no plugin loading.
- **`opencode --standalone run` takes the server down with it when the run ends.** You cannot drive `/api/shell` against it afterwards.
- **Use a local model for smoke tests.** `collab-ollama/*` needs no credits and calls tools correctly.
- **Never `pkill -f <pattern>` where the pattern can match your own shell.** `pkill -f 'opencode acp'` and `pkill -f tor` both killed the calling shell. Match a pid from `ps` and kill that.

---

## How to verify a change

Three layers, cheapest first.

### 1. Unit — no server, no tor

`test/harness.ts` drives the real `setup()` with a fake ctx: a stubbed
`ctx.shell.hook`, a stubbed `ctx.tool.transform`, and a temporary `home`.

```bash
node --experimental-strip-types test/harness.ts
```

It asserts registration, that nothing is injected while the tunnel is down, the
exact `socks5h` env when it is up, `tor_off` suppression, the adoption line, a
named rotation failure, and unregistration on dispose. It opens a throwaway
listener on a high port and never touches a real tor. Run this after every code
change.

### 2. Load — plugin reaches a live server

```bash
mkdir -p /tmp/probe/.opencode/plugins/canary
cat > /tmp/probe/.opencode/plugins/canary/index.ts <<'EOF'
import { writeFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "canary",
  async setup() {
    writeFileSync("/tmp/probe/canary.txt", "setup ran")
  },
})
EOF
cd /tmp/probe && opencode --standalone run "say ok"
cat /tmp/probe/canary.txt
```

If the file exists, discovery and import work. If not, the problem is loading,
not your logic.

### 3. End-to-end — a model runs a command

Something free and local:

```bash
opencode --standalone run --model collab-ollama/qwen3:8b "run: env | grep -i proxy"
```

Expect all eight proxy variables. Then check egress really moved:

```bash
opencode --standalone run --model collab-ollama/qwen3:8b \
  "run exactly: curl -sS -m 45 https://check.torproject.org/api/ip"
```

`IsTor: true` and an IP that is not yours. Compare against a direct `curl` —
without the comparison, a passing test proves nothing.

---

## Test hygiene

- **Fresh `home` per test.** `rm -rf` the test home before starting, and only
  while nothing is running against it. Removing a live tor's data directory
  deletes its control cookie and breaks rotation in a way that looks like a
  plugin bug.
- **Stop tor by pid.** `ps aux | grep '[t]or -f'`, then `kill <pid>`. The
  pidfile may be gone if the data dir was deleted.
- **Pick a non-default port** when you want to prove the auto-start path. A
  stray tunnel on 9050 turns every run into "already listening" and hides the
  path you meant to test.
- **Check for leftovers** before reading results:
  `ss -ltn | grep -E ':(9050|9051)\b'`.

---

## Code conventions

- TypeScript, no build step — OpenCode loads `.ts` directly.
- `import { Plugin } from "@opencode/plugin"` and `Plugin.define({ id, setup })`.
- Return a cleanup function that disposes the hook and the tool transform and
  turns injection off. Leave tor running. See ARCHITECTURE, "Deliberate
  omissions".
- Keep state in one mutable object closed over by hooks and tools. Do not scatter module-level variables — a second plugin instance in the same process would share them.
- Every shell call goes through the local `sh()` helper, which has a timeout and resolves on `error` as well as `close`. Do not call `spawn` inline.
- Tool failures must say why. A bare `false` surfaces to the model as
  "unavailable", which is exactly the message that hides a fixable cause.

---

## Things not to do

- **Don't add `-X POST`-style forcing to curl invocations** without understanding redirect semantics; curl re-forces the method on every hop and breaks one-shot CSRF flows. (This bit the companion `torctl` project.)
- **Don't `pkill -f`** a pattern that can match your own shell — see above.
- **Don't auto-rotate mid-session.** Targets that bind session state to IP will drop you. Rotation stays a tool call.
- **Don't kill tor on plugin unload.** It's shared.
- **Don't use `socks5://`** — only `socks5h://`. Plain `socks5` resolves DNS locally and leaks the hostname.
- **Don't trust `exitIP` in state without calling refresh.** It is a cache.
- **Don't assume an open port is your tunnel.** Check the pidfile. See
  ARCHITECTURE, "Ownership".

---

## Testing checklist

All of these have been observed passing; re-run the ones your change touches.

1. `node --experimental-strip-types test/harness.ts` → all pass.
2. Clean port, nothing else on it → plugin writes torrc, spawns tor, bootstraps, `owner: this plugin`.
3. `env | grep -i proxy` inside a session → eight variables.
4. Local service still reachable through injection (`NO_PROXY` works).
5. Direct `curl` says `IsTor:false`, session `curl` says `IsTor:true`.
6. `tor_rotate` → exit IP changes.
7. `tor_off` → next command direct. `tor_on` → next command tunnelled.
8. Restart the server → tunnel still up, `inject` back to its default.

---

## Publishing

`package.json` declares `exports: { ".": "./src/index.ts" }` and a `@opencode/plugin` dependency. That shape is what OpenCode's loader expects for both a local directory and a published package.

Before `npm publish`: bump version, confirm `files` includes `src`, and do not ship `node_modules`, test scratch directories, or `*.log`.
