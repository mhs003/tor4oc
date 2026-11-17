# Architecture

`tor4oc` is a single OpenCode server plugin that holds one Tor tunnel for the life of the server process and routes every session's shell commands through it.

`https://github.com/mhs003/tor4oc`

```
                    ┌─────────────────────────────────────┐
                    │      OpenCode server process        │
                    │                                     │
  session A ────────┤  plugin: tor4oc                     │
  session B ────────┤    ├─ state (ports, home, flags)    │
  session C ────────┤    ├─ tor lifecycle (spawn/poll)    │
                    │    ├─ shell hook  ──────┐           │
                    │    └─ tools: tor_*      │           │
                    └─────────────────────────┼───────────┘
                                              │ env injection
                                              ▼
                                   ┌────────────────────┐
                                   │ every shell command│
                                   │  ALL_PROXY=socks5h │
                                   └─────────┬──────────┘
                                             ▼
                                   ┌────────────────────┐
                                   │ tor  127.0.0.1:9050│
                                   └─────────┬──────────┘
                                             ▼
                                      tor network exit
```

---

## Lifecycle

1. **Load.** OpenCode resolves the package from `plugins` in `opencode.json(c)` (or auto-loads from `.opencode/plugins/`), imports the default export, calls `Plugin.define`'s `setup`.
2. **Setup, tunnel phase.** `start()` runs:
   - if the SOCKS port is already open → adopt it, return `already listening`
   - else if `autoStart` → write torrc, `spawn("tor", ["-f", torrc], { detached: true })`, unref, poll the log for `Bootstrapped 100%`
   - verify with a real request to `check.torproject.org`
3. **Setup, registration phase.** A shell hook is registered, then four tools via `ctx.tool.transform`.
4. **Steady state.** Every shell invocation passes through the hook, which mutates `event.env` before the process spawns.
5. **Unload.** Cleanup is a no-op by design — tor stays up for other sessions and later runs.

---

## The shell hook — why this is the core

`ctx.shell.hook("create.before", (event) => …)` receives a mutable `event.env`. Writing proxy variables there covers **every** shell call in **every** session on that server, without the model needing to know tor exists.

```ts
await ctx.shell.hook("create.before", (event) => {
  if (!state.inject) return
  if (!state.running) return
  Object.assign(event.env, proxyEnv)
})
```

Variables written:

| variable | value |
|---|---|
| `ALL_PROXY`, `all_proxy` | `socks5h://127.0.0.1:<port>` |
| `HTTP_PROXY`, `http_proxy` | same |
| `HTTPS_PROXY`, `https_proxy` | same |
| `NO_PROXY`, `no_proxy` | loopback + RFC1918, so local services stay reachable |
| `TORCTL_SOCKS_PORT`, `TORCTL_CTRL_PORT`, `TORCTL_HOME` | exported for tooling that wants them |

`socks5h` (not `socks5`) makes curl resolve DNS **through** the proxy. With plain `socks5` the hostname resolution happens locally and leaks.

Two guards, both deliberate: `inject` (user toggled off) and `running` (no tunnel, so no injection — a dead proxy would break every command).

---

## State

A single mutable `State` object closed over by the hook and all four tools:

```ts
type State = {
  socksPort: number      // default 9050
  ctrlPort: number       // default 9051
  home: string           // default ~/.cache/torctl
  autoStart: boolean     // default true
  inject: boolean        // default true
  running: boolean       // refreshed by port checks
  exitIP: string | null  // from check.torproject.org
  isTor: boolean         // ditto
  lastError: string | null
}
```

`running`, `exitIP`, and `isTor` are **cached with explicit refresh**, not read live. `tor_status` and `tor_rotate` refresh before reporting; the shell hook reads the cached `running` only, because a network round-trip per shell command would be unacceptable.

---

## Control channel

Rotation uses tor's control port with cookie auth:

```
AUTHENTICATE <hex(cookie bytes)>
SIGNAL NEWNYM
QUIT
```

Sent over a raw `node:net` socket to `127.0.0.1:<ctrlPort>`. Cookie read from `<home>/data/control_auth_cookie`.

Tor rate-limits NEWNYM to roughly one per 10s. A request inside that window is queued, not rejected — the log shows `Rate limiting NEWNYM request: delaying by N second(s)`. The code sleeps 1.2s after the signal, which is enough for the common case but will silently return a stale exit if called in a tight loop.

---

## Tools

Registered in one `ctx.tool.transform` call, sharing the namespace `tor`:

| tool | effect | touches network |
|---|---|---|
| `tor_status` | refreshes and reports state, exit IP, `isTor`, boot result | yes (one HTTPS request) |
| `tor_rotate` | NEWNYM, then refreshes | yes |
| `tor_off` | `state.inject = false` | no |
| `tor_on` | starts if down, `state.inject = true`, refreshes | yes |

All are `codemode`-eligible by default and return `{ content: string }`.

---

## Failure modes and how the design handles them

| failure | behaviour |
|---|---|
| `tor` binary missing | `spawn` emits `error`; `sh()` resolves with code −1; bootstrap poll times out; `running` stays false; hook never injects |
| port already bound | `start()` adopts it — see OPEN PROBLEM in TRACK.md |
| cookie file absent | `rotate()` returns false, tool reports it |
| control port refuses | `sendControl` resolves false after timeout |
| exit is up but not Tor | `isTor` false; `tor_status` surfaces it; hook still injects (the exit works, it just isn't anonymising) |
| tor dies mid-session | cached `running` stays true until a refresh; next `tor_status` corrects it |

---

## Deliberate omissions

- **Does not kill tor on unload.** Shared resource.
- **Does not persist `inject` state.** Reset per server run.
- **Does not rotate automatically.** Rotation is a decision, not a side effect — auto-rotating mid-request would break session continuity on targets that bind state to IP.
- **Does not proxy the model's own HTTP calls.** Provider traffic is untouched; this covers shell commands only.
