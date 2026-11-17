# TRACK

Work log for `tor4oc`. Newest last.

Status: **functional core, unverified end-to-end in a real session.**

---

## Decisions

- **Node built-ins only.** The plugin runs inside the OpenCode server binary. `Bun.*` is not guaranteed to exist there, so everything uses `node:child_process`, `node:fs`, `node:net`. Confirmed correct after replacing an initial Bun-based draft.
- **Shell hook over per-command wrappers.** `ctx.shell.hook("create.before")` injects proxy env into every shell call. This is what makes the whole session tunnelled rather than requiring each command to be prefixed.
- **Tor survives plugin unload.** The cleanup function deliberately does not kill tor. Multiple sessions and later server runs reuse one tunnel. Stopping it stays an explicit action.
- **Rotation via control port.** `SIGNAL NEWNYM` over the cookie-authenticated control socket, not a process restart.
- **No `.htaccess`-style tricks, no config mutation.** The plugin only reads state and injects env.

---

## What was built

| file | role |
|---|---|
| `src/index.ts` | the plugin: state, tor lifecycle, shell hook, four tools |
| `package.json` | `@opencode/plugin` dependency, `exports` → `src/index.ts` |
| `tsconfig.json` | typecheck config |

Four tools registered under the `tor` namespace:

- `tor_status` — tunnel state, exit IP, whether egress is really Tor
- `tor_rotate` — new circuit mid-session
- `tor_off` — stop injecting proxy env
- `tor_on` — resume

Options: `socksPort`, `ctrlPort`, `home`, `autoStart`, `inject`.

---

## Verified

- `tsc -p tsconfig.json` → **clean**, strict mode, no errors.
- Module imports under Node 26 (`node --input-type=module -e "import('./src/index.ts')"`) → default export resolves.
- `node_modules/@opencode/plugin` **2.3.0** installs and its types match the code.
- OpenCode version in use: **v2.2.6**.

### Runtime findings from canary plugins

Three throwaway plugins proved the surrounding machinery works, which narrowed the remaining problem down to this plugin specifically:

| canary | result |
|---|---|
| plain `index.ts` in `.opencode/plugins/<name>/`, no imports | **loaded, setup ran** |
| same + `import { Plugin } from "@opencode/plugin"` | **import ok, setup ran** |
| `Plugin.define` + `ctx.tool.transform` + `ctx.shell.hook("create.before")` | **all ok** — transform called 4×, hook registered |

So: local plugin discovery works, the V2 import works, and both API surfaces this plugin needs work.

### Latest instrumented run

The real plugin, with a debug log patched in, reported:

```
setup entered
start() -> already listening
```

`start()` returned **already listening** because a tor instance was already bound to the default port — a leftover from the `torctl` skill work, not the plugin's own tunnel. Setup completed without throwing.

**Not yet verified:** that the shell hook actually injects, that the tools appear in a model's tool list, that a command's egress really changes.

---

## Open problems

1. **`/api/plugin` returns `{"data":[]}`** for every plugin path form tried — absolute, relative, `file://`, and local directory. Either that endpoint lists only remote plugins, or local ones are filtered. The canary proves loading happens regardless, so treat `/api/plugin` as an unreliable signal, not a failure indicator.

2. **Port collision between the plugin and an existing tunnel.** With `socksPort` at its default and `torctl` already holding 9050, `start()` short-circuits to `already listening` and the plugin adopts someone else's tunnel. Acceptable behaviour, but it means the plugin can silently use a tunnel it did not configure. Worth an explicit origin check.

3. **No isolation test.** All runs so far happened on a machine where 9050 was already up, so the auto-start path (write torrc → spawn tor → poll for `Bootstrapped 100%`) has **never actually executed**. Needs one run on a clean port.

4. **Tool namespace naming.** `editor.namespace({ name: "tor" })` with tools `status`/`rotate`/`off`/`on` should surface as `tor_status` etc. Unconfirmed in a live tool list.

5. **`tor_off` / `tor_on` mutate plugin state, not persisted config.** They reset on server restart. Intentional, undocumented in the tool descriptions.

---

## Next steps

1. Test on a clean port (`socksPort: 9250`) with nothing else running, and confirm the auto-start path writes torrc, spawns tor, and bootstraps.
2. Confirm the shell hook fires: run `env | grep -i proxy` inside a session and check the vars are present.
3. Confirm tools register: list available tools in a session and look for `tor_status`.
4. Confirm egress actually changes: `curl https://check.torproject.org/api/ip` through a session shell should report `IsTor: true`.
5. Add a real integration test script rather than manual canaries.

---

## Known-good reference points

From the `torctl` skill (same author, same domain) these are proven working and can be borrowed if the plugin misbehaves:

- torrc shape: `SocksPort`, `ControlPort`, `CookieAuthentication 1`, `DataDirectory`, `Log notice file`
- bootstrap detection: poll the log for `Bootstrapped 100%`
- rotation: hex-encode the 32-byte cookie, send `AUTHENTICATE <hex>\r\nSIGNAL NEWNYM\r\nQUIT\r\n`
- egress check: `https://check.torproject.org/api/ip` → `{"IsTor":true,"IP":"..."}`
- Tor rate-limits NEWNYM — roughly one request per 10 seconds; the client must tolerate `Rate limiting NEWNYM request: delaying by N second(s)` in the log.
