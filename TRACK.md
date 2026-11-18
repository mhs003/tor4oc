# TRACK

Work log for `tor4oc`. Newest last.

Status: **verified end-to-end.** Every claim below was observed on a real
OpenCode server with a real model driving real shell commands.

---

## Decisions

- **Node built-ins only.** The plugin runs inside the OpenCode server binary. `Bun.*` is not guaranteed to exist there, so everything uses `node:child_process`, `node:fs`, `node:net`. Confirmed correct after replacing an initial Bun-based draft.
- **Shell hook over per-command wrappers.** `ctx.shell.hook("create.before")` injects proxy env into every shell call. This is what makes the whole session tunnelled rather than requiring each command to be prefixed.
- **Tor survives plugin unload.** The cleanup function deliberately does not kill tor. Multiple sessions and later server runs reuse one tunnel. Stopping it stays an explicit action. The cleanup *does* unregister the hook and tools, and turns injection off, so an unloaded plugin cannot keep routing.
- **Rotation via control port.** `SIGNAL NEWNYM` over the cookie-authenticated control socket, not a process restart.
- **Ownership is tracked.** A pidfile whose pid is still alive means the tunnel is ours and its cookie is valid. Otherwise the tunnel was adopted from something else, and rotation will not work against it.

---

## What was built

| file | role |
|---|---|
| `src/index.ts` | the plugin: state, tor lifecycle, shell hook, four tools |
| `test/harness.ts` | drives `setup()` with a fake ctx; 23 assertions, no server needed |
| `package.json` | `@opencode/plugin` dependency, `exports` → `src/index.ts` |
| `tsconfig.json` | typecheck config |

Four tools registered under the `tor` namespace, reached by the model as
`tor_status`, `tor_rotate`, `tor_off`, `tor_on` (code-mode: `tools.tor.status`
and so on).

Options: `socksPort`, `ctrlPort`, `home`, `autoStart`, `inject`.

---

## Verified

### Build

- `tsc -p tsconfig.json` → clean, strict, no errors.
- `node --experimental-strip-types test/harness.ts` → **23 passed, 0 failed**.
- `@opencode/plugin` 2.3.0, OpenCode v2.2.6.

### Auto-start, on a machine with no tor running

Started with an empty home directory and nothing on ports 9050/9051:

```
torrc written          SocksPort 9050 / ControlPort 9051 / CookieAuthentication 1
tor spawned            /usr/bin/tor -f <home>/torrc
pidfile written        17103
bootstrap              "Bootstrapped 100% (done)"
cookie written         <home>/data/control_auth_cookie (32 bytes)
egress                 {"IsTor":true,"IP":"192.42.116.142"}
```

### Hook injection, end-to-end

A model (`river/deepseek-ai/DeepSeek-V4.1-Flash-1017`) was asked to run
`env | grep -i proxy`. The command itself printed:

```
ALL_PROXY=socks5h://127.0.0.1:9050
all_proxy=socks5h://127.0.0.1:9050
HTTP_PROXY=socks5h://127.0.0.1:9050
http_proxy=socks5h://127.0.0.1:9050
HTTPS_PROXY=socks5h://127.0.0.1:9050
https_proxy=socks5h://127.0.0.1:9050
NO_PROXY=localhost,127.0.0.1,::1
no_proxy=localhost,127.0.0.1,::1
```

No wrapper was used. The model did not know the plugin existed.

### Egress actually changes

Same command, both ways:

| path | result |
|---|---|
| direct | `{"IsTor":false,"IP":"27.147.163.80"}` |
| through the plugin, unwrapped | `{"IsTor":true,"IP":"192.42.116.142"}` |

### Tools register and run

Asked which tools it had, the model listed all four and called `tor_status`,
which returned live tunnel state including `is tor: yes`.

### Rotation

`tor_rotate` moved the exit from `204.8.96.185` to `89.58.26.216`.

### Toggle

In one session: `tor_off` → command returned `IsTor:false`, the direct IP.
`tor_on` → `IsTor:true`, the Tor exit. Both took effect on the next command.

### Loopback stays direct

With injection on, `curl http://127.0.0.1:18080/` still reached the local
server, because `NO_PROXY` covers loopback and RFC1918.

---

## Fixed during verification

1. **`setup()` leaked registrations.** The returned cleanup was an empty
   function, so the shell hook and tool transform stayed registered after
   unload. It now flips `inject` off and disposes both, while still leaving tor
   running.

2. **Rotation failed opaquely.** It returned a bare `false`, reported to the
   model as "control port or cookie unavailable". The real cause was a cookie
   path taken from config while the tor answering on the port was a different
   instance (a leftover whose data directory had been deleted). `rotate()` now
   returns a reason, and each failure names its cause.

3. **Ownership was invisible.** `start()` reported "already listening" whether
   it had just spawned tor or attached to a stranger, and `tor_status` gave no
   way to tell. It now checks that the pid in the pidfile is alive and reports
   `owner: this plugin` or `owner: adopted (not started by this plugin)`.

---

## Environment notes

- **`/api/plugin` is not a reliable signal.** It returned `{"data":[]}` for
  every plugin path form while plugins demonstrably loaded. `opencode plugin
  list` also said "No plugins found" for a working plugin. Verify by side
  effect.
- **`opencode api` starts a throwaway server per call.** Shells created in one
  call do not exist in the next; plugins do not load there either.
- **`opencode acp` is stdio, not HTTP.** No port, no plugin loading.
- **`--standalone run` exits when the run ends**, taking the server with it, so
  the shell API cannot be driven against it afterwards.
- **Use a local model for smoke tests.** `collab-ollama/*` needs no credits and
  drives tool calls fine.

### Provider traffic stays direct

Turning injection on reroutes shell commands only. The model client is a
separate HTTP stack that cannot speak `socks5h`, so the provider API hosts are
listed in `NO_PROXY`. Without that, the first turn after enabling the plugin
fails with `UnsupportedProxyProtocol` and retries until it gives up.

Verified: with injection on by default, a session both reached its API and
returned `{"IsTor":true,"IP":"185.246.190.83"}` from a shell command.

---

## Open questions

1. **Adopting a stranger's tunnel is still allowed.** If something else holds
   the SOCKS port, the plugin uses it and says so. That is a reasonable default
   (it keeps working), but a user who expects *their* tunnel should know that
   rotation will fail. Consider `strict: true` to refuse adoption.
2. **`tor_off` / `tor_on` are not persisted.** They reset on server restart.
   Intentional; the tool descriptions say "for the rest of this server run".
3. **The plugin does not verify after a rotation that the new exit differs.**
   Tor rate-limits NEWNYM, so a request inside the window is queued; a poll
   until the IP changes would be more honest than a fixed 1.2s sleep.
4. **No Windows support tested.** The pid-liveness check uses
   `process.kill(pid, 0)`, which behaves differently there.

---

## Known-good reference points

From the companion `torctl` project (same author), proven working:

- torrc shape: `SocksPort`, `ControlPort`, `CookieAuthentication 1`, `DataDirectory`, `Log notice file`
- bootstrap detection: poll the log for `Bootstrapped 100%`
- rotation: hex-encode the 32-byte cookie, send `AUTHENTICATE <hex>\r\nSIGNAL NEWNYM\r\nQUIT\r\n`
- egress check: `https://check.torproject.org/api/ip` → `{"IsTor":true,"IP":"..."}`
- Tor rate-limits NEWNYM — roughly one request per 10 seconds
