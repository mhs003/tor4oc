# AGENTS.md

Notes for agents (and people) working on `tor4oc`.

---

## What this is

An OpenCode server plugin. One Tor tunnel per server process, proxy env injected into every shell command via `ctx.shell.hook("create.before")`, plus four tools under the `tor` namespace.

Read `ARCHITECTURE.md` before changing anything structural. Read `TRACK.md` for current state and open problems — **the plugin is not yet verified end-to-end.**

---

## Environment facts learned the hard way

- **Node built-ins only.** The plugin runs inside the OpenCode server binary. Do not assume `Bun.*`. An initial draft used `Bun.spawn` / `Bun.connect` / `Bun.write` and had to be rewritten to `node:child_process`, `node:net`, `node:fs/promises`.
- **`@opencode/plugin` is the V2 package**, not `@opencode-ai/plugin` (V1). V2 is `2.3.0` as of writing. The V1 package may also be present on a machine and is the wrong import.
- **OpenCode dev build in use is v2.2.6.** Re-check the API surface if that moves.
- **Typecheck with `./node_modules/.bin/tsc -p tsconfig.json`.** Needs `@types/node` and `typescript` as dev deps. Without `@types/node` every `node:` import errors with `TS2591`.
- **`/api/plugin` returning `{"data":[]}` is not proof of failure.** Local plugins demonstrably load while that endpoint stays empty. Verify by side effect, not by that listing.

---

## How to verify a change

Side effects beat logs. Write a canary:

```bash
mkdir -p .opencode/plugins/canary
cat > .opencode/plugins/canary/index.ts <<'EOF'
import { writeFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "canary",
  async setup(ctx) {
    writeFileSync("/tmp/canary.txt", "setup ran")
    await ctx.shell.hook("create.before", (e) => {
      writeFileSync("/tmp/canary-hook.txt", JSON.stringify(e.env, null, 2))
    })
  },
})
EOF
opencode --standalone run "echo hi"
cat /tmp/canary.txt /tmp/canary-hook.txt
```

If both files exist, the plugin loaded and the hook fired. If only the first, setup ran but nothing invoked a shell. If neither, the plugin never loaded.

**Always test on a port nothing else holds.** A part of `TRACK.md`'s open problems is that every run so far hit an existing tunnel and returned `already listening`, so the auto-start path is untested. Pass a non-default `socksPort` and stop other tor instances first.

---

## Code conventions

- TypeScript, no build step — OpenCode loads `.ts` directly.
- `import { Plugin } from "@opencode/plugin"` and `Plugin.define({ id, setup })`.
- Return a cleanup function from `setup` **only** if there is real cleanup. Here it is deliberately empty (see ARCHITECTURE, "Deliberate omissions").
- Keep state in one mutable object closed over by hooks and tools. Do not scatter module-level variables — a second plugin instance in the same process would share them.
- Every shell call goes through the local `sh()` helper, which has a timeout and resolves on `error` as well as `close`. Do not call `spawn` inline.

---

## Things not to do

- **Don't add `-X POST`-style forcing to curl invocations** without understanding redirect semantics; curl re-forces the method on every hop and breaks one-shot CSRF flows. (This bit the companion `torctl` project.)
- **Don't `pkill -f tor`.** The pattern matches the shell running the command. Use the pidfile at `<home>/tor.pid`.
- **Don't auto-rotate mid-session.** Targets that bind session state to IP will drop you. Rotation stays a tool call.
- **Don't kill tor on plugin unload.** It's shared.
- **Don't use `socks5://`** — only `socks5h://`. Plain `socks5` resolves DNS locally and leaks the hostname.
- **Don't trust `exitIP` in state without calling refresh.** It is a cache.

---

## Testing checklist before calling anything fixed

1. Clean port, nothing else on it → plugin spawns tor, writes torrc, bootstraps.
2. `env | grep -i proxy` inside a session → the six proxy vars plus `NO_PROXY`.
3. Local service still reachable → `curl http://127.0.0.1:PORT` works despite the proxy (that's what `NO_PROXY` is for).
4. `curl https://check.torproject.org/api/ip` → `IsTor: true`.
5. `tor_rotate` → exit IP changes.
6. `tor_off` → next command is direct again. `tor_on` → back through.
7. Restart the server → tunnel still up, `inject` back to its default.

---

## Publishing

`package.json` declares `exports: { ".": "./src/index.ts" }` and a `@opencode/plugin` dependency. That shape is what OpenCode's loader expects for both a local directory and a published package.

Before `npm publish`: bump version, confirm `files` includes `src`, and do not ship `node_modules` or `.test-project`.
