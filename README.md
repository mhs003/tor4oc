# tor4oc

**Tor for OpenCode.** One Tor tunnel per server, and every shell command in every session goes through it — no per-command wrappers.

```
https://github.com/mhs003/tor4oc
```

<br>

> **Status: verified end-to-end.**
> A real session was observed leaving through the tunnel with no wrapper, rotating its exit, and toggling injection off and on. See [`TRACK.md`](TRACK.md) for the evidence and for what is still open.

<br>

## Why

The IP on your first request is on every request after it. If a session does network work you'd rather not attribute to this machine, the egress has to be decided before the first command runs — retrofitting protects nothing that already happened.

`tor4oc` makes the tunnel the default for the whole session. The model never has to remember to use it.

<br>

## Install

Requires `tor`.

```bash
# Debian/Ubuntu
sudo apt install tor curl

# macOS
brew install tor
```

As a local plugin — drop it in your config:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/tor4oc"]
}
```

Or clone into the project:

```bash
git clone https://github.com/mhs003/tor4oc .opencode/plugins/tor4oc
```

<br>

## Options

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/tor4oc",
      "options": {
        "socksPort": 9050,
        "ctrlPort": 9051,
        "home": "~/.cache/torctl",
        "autoStart": true,
        "inject": true
      }
    }
  ]
}
```

| option | default | meaning |
|---|---|---|
| `socksPort` | `9050` | SOCKS5 listener |
| `ctrlPort` | `9051` | control port for circuit rotation |
| `home` | `~/.cache/torctl` | torrc, data dir, control cookie, pidfile |
| `autoStart` | `true` | spawn tor if nothing is listening |
| `inject` | `true` | inject proxy env into shell commands (provider API hosts excluded) |

<br>

## What gets injected

Every shell command receives:

```
ALL_PROXY / all_proxy        socks5h://127.0.0.1:<port>
HTTP_PROXY / http_proxy      socks5h://127.0.0.1:<port>
HTTPS_PROXY / https_proxy    socks5h://127.0.0.1:<port>
NO_PROXY / no_proxy          loopback + RFC1918 + provider API hosts
```

`socks5h` rather than `socks5` matters — plain `socks5` resolves DNS locally and leaks the hostname before the request leaves.

`NO_PROXY` keeps local services reachable, so `curl http://127.0.0.1:8000` still works.

It also covers the model API hosts. OpenCode's provider client is a separate
HTTP stack that cannot speak a socks proxy; without that exclusion, the first
turn after enabling the plugin fails with `UnsupportedProxyProtocol`. Model
traffic stays direct, shell commands go through Tor. If your provider is not on
the built-in list, add its host or it will break.

<br>

## Tools

Four tools appear under the `tor` namespace:

| tool | does |
|---|---|
| `tor_status` | tunnel state, exit IP, whether egress is really Tor, and who started the tunnel |
| `tor_rotate` | new circuit, so the next requests leave from a different exit |
| `tor_off` | stop injecting the proxy for the rest of the server run |
| `tor_on` | resume injecting |

Model-facing descriptions tell it when to reach for each.

`tor_status` reports `owner: this plugin` when the plugin started the tunnel, or
`owner: adopted (not started by this plugin)` when it found one already
listening. An adopted tunnel still carries traffic, but rotation cannot work
against it — it needs a control cookie the plugin can read. `tor_rotate` says so
rather than failing quietly.

<br>

## Verify it's working

Download the plugin and enable it, then inside a session:

```bash
env | grep -i proxy
# ALL_PROXY=socks5h://127.0.0.1:9050
# ...

curl -sS https://check.torproject.org/api/ip
# {"IsTor":true,"IP":"..."}
```

`IsTor: false` means the request bypassed the proxy. Check that before debugging anything else.

<br>

## When a target misbehaves

Tor exits are routinely blocked or rate-limited. Symptoms: `403` on Cloudflare-fronted admin panels, instant `429`, `503`, or slow timeouts on URLs that worked directly.

1. `tor_rotate` for a different exit.
2. Confirm `IsTor: true`.
3. Compare one direct request against one tunnelled request.

If direct works and tunnelled fails, it's the exit, not the target.

<br>

## Notes

- Tor rate-limits circuit rotation to roughly one per 10 seconds. A rotation inside that window is queued, not rejected.
- The tunnel is **not** stopped when the plugin unloads — it's shared across sessions and later server runs. The hook and tools are unregistered, so nothing keeps routing.
- Provider traffic (model API calls) is untouched. This covers shell commands only.
- Don't `pkill -f tor` — the pattern matches the shell running the command. Use the pidfile in `home`, or a pid from `ps`.

<br>

## Tests

The plugin's logic can be checked without a server or a tor instance:

```bash
node --experimental-strip-types test/harness.ts
```

It drives the real `setup()` with a fake context and asserts the injected
environment, the toggle, the ownership line, and cleanup. `AGENTS.md` covers
the two further layers — proving the plugin loads in a live server, and proving
a model's command really leaves through the tunnel.

<br>

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — design, shell hook, state, control channel, failure modes
- [`TRACK.md`](TRACK.md) — what's verified, what isn't, open problems, next steps
- [`AGENTS.md`](AGENTS.md) — for agents and contributors: environment facts, canary recipe, do-nots, test checklist

<br>

## License

MIT
