# tor4oc

**Tor for OpenCode.** One Tor tunnel per server, and every shell command in every session goes through it — no per-command wrappers.

```
https://github.com/mhs003/tor4oc
```

<br>

> **Status: functional core, not yet verified end-to-end.**
> The auto-start path has never executed, because testing kept hitting an existing tunnel on the default port. See [`TRACK.md`](TRACK.md) for what is proven and what is not.

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
| `inject` | `true` | inject proxy env into shell commands |

<br>

## What gets injected

Every shell command receives:

```
ALL_PROXY / all_proxy        socks5h://127.0.0.1:<port>
HTTP_PROXY / http_proxy      socks5h://127.0.0.1:<port>
HTTPS_PROXY / https_proxy    socks5h://127.0.0.1:<port>
NO_PROXY / no_proxy          loopback + RFC1918
```

`socks5h` rather than `socks5` matters — plain `socks5` resolves DNS locally and leaks the hostname before the request leaves.

`NO_PROXY` keeps local services reachable, so `curl http://127.0.0.1:8000` still works.

<br>

## Tools

Four tools appear under the `tor` namespace:

| tool | does |
|---|---|
| `tor_status` | tunnel state, exit IP, whether egress is really Tor |
| `tor_rotate` | new circuit, so the next requests leave from a different exit |
| `tor_off` | stop injecting the proxy for the rest of the server run |
| `tor_on` | resume injecting |

Model-facing descriptions tell it when to reach for each.

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
- The tunnel is **not** stopped when the plugin unloads — it's shared across sessions and later server runs.
- Provider traffic (model API calls) is untouched. This covers shell commands only.
- Don't `pkill -f tor`. Use the pidfile in `home`.

<br>

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — design, shell hook, state, control channel, failure modes
- [`TRACK.md`](TRACK.md) — what's verified, what isn't, open problems, next steps
- [`AGENTS.md`](AGENTS.md) — for agents and contributors: environment facts, canary recipe, do-nots, test checklist

<br>

## License

MIT
