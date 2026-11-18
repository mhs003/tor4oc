import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { mkdir, writeFile, readFile, access } from "node:fs/promises"
import { constants } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * tor4oc
 *
 * Holds one Tor tunnel for the life of the OpenCode server and makes every
 * shell command in every session egress through it. Commands do not need to
 * prefi x themselves with a wrapper — the proxy environment is injected by a
 * shell hook.
 *
 * Environment injected per command:
 *   ALL_PROXY / all_proxy            socks5h://127.0.0.1:<port>
 *   HTTPS_PROXY / HTTP_PROXY         same
 *   https_proxy / http_proxy         same
 *   NO_PROXY / no_proxy              loopback + link-local, so local tools work
 *
 * Tools registered:
 *   tor_status   — tunnel state, exit IP, whether egress is really Tor
 *   tor_rotate   — request a new circuit mid-session
 *   tor_off      — stop injecting the proxy for the rest of the server run
 *   tor_on       — resume injecting it
 *
 * Options (opencode.jsonc plugins entry):
 *   socksPort   number  default 9050
 *   ctrlPort    number  default 9051
 *   home        string  default ~/.cache/torctl
 *   autoStart   boolean default true — spawn tor if it is not already up
 *   inject      boolean default false — proxy env into shell commands
 *
 * Off by default: installing the plugin should not quietly reroute unrelated
 * work. Turn it on with tor_on for a session, or inject: true for a project
 * whose every command should leave through tor.
 *
 * The provider client that talks to the model API is a separate HTTP stack and
 * cannot speak a socks proxy. Its hosts are read from the server's provider
 * records and added to NO_PROXY, so model traffic stays direct even while
 * shell commands are tunnelled.
 */

const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

// Hosts OpenCode itself talks to. These must never go through the socks proxy:
// Nothing vendor-specific is listed. Hosts are read from the provider records
// the server already holds, so a new or self-hosted provider is covered without
// editing this file.

type State = {
  socksPort: number
  ctrlPort: number
  home: string
  autoStart: boolean
  inject: boolean
  running: boolean
  adopted: boolean
  exitIP: string | null
  isTor: boolean
  lastError: string | null
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function sh(cmd: string, args: string[], timeout = 60_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: { ...process.env } })
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {}
    }, timeout)

    proc.stdout?.on("data", (d) => {
      out += d.toString()
    })
    proc.stderr?.on("data", (d) => {
      err += d.toString()
    })
    proc.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: e.message })
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port })
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(2000)
    sock.on("connect", () => done(true))
    sock.on("timeout", () => done(false))
    sock.on("error", () => done(false))
  })
}

function sendControl(port: number, payload: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port })
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(4000)
    sock.on("connect", () => {
      sock.write(payload)
      setTimeout(() => done(true), 400)
    })
    sock.on("timeout", () => done(false))
    sock.on("error", () => done(false))
  })
}

async function readExit(state: State): Promise<{ ip: string | null; isTor: boolean }> {  const r = await sh(
    "curl",
    [
      "-sS",
      "-m",
      "45",
      "--socks5-hostname",
      `127.0.0.1:${state.socksPort}`,
      "https://check.torproject.org/api/ip",
    ],
    60_000,
  )
  if (r.code !== 0 || !r.out.trim()) return { ip: null, isTor: false }
  try {
    const j = JSON.parse(r.out) as { IP?: string; IsTor?: boolean }
    return { ip: j.IP ?? null, isTor: j.IsTor === true }
  } catch {
    return { ip: null, isTor: false }
  }
}

// True when the pid in our pidfile is a live process, i.e. the tunnel on the
// port is one this plugin started and whose cookie lives in our home.
async function pidAlive(pidfile: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(pidfile, "utf8")
  } catch {
    return false
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Every host the model client might talk to, taken from the provider records
// rather than from a list maintained by hand. A custom or newly added provider
// is excluded automatically, which is the only way this stays correct.
function providerHosts(records: readonly unknown[]): string[] {
  const hosts = new Set<string>()
  for (const rec of records) {
    // Records arrive in two shapes: the client returns the provider itself,
    // while the editor wraps it as { provider }. Accept both.
    const r = rec as { settings?: unknown; provider?: { settings?: unknown } } | undefined
    const settings = (r?.settings ?? r?.provider?.settings) as { baseURL?: unknown } | undefined
    const base = settings?.baseURL
    if (typeof base !== "string") continue
    try {
      const h = new URL(base).hostname
      // baseURLs may contain template placeholders like ${databricks_host};
      // those are not real hosts and must not end up in NO_PROXY.
      if (h && !h.includes("$") && !h.includes("{")) hosts.add(h)
    } catch {
      // A baseURL that will not parse is the provider client's problem, not ours.
    }
  }
  return [...hosts]
}

export default Plugin.define({
  id: "tor",

  async setup(ctx) {
    const opts = (ctx.options ?? {}) as Record<string, unknown>

    const state: State = {
      socksPort: typeof opts.socksPort === "number" ? opts.socksPort : 9050,
      ctrlPort: typeof opts.ctrlPort === "number" ? opts.ctrlPort : 9051,
      home: expandHome(typeof opts.home === "string" ? opts.home : "~/.cache/torctl"),
      autoStart: opts.autoStart !== false,
      inject: opts.inject === true,
      running: false,
      adopted: false,
      exitIP: null,
      isTor: false,
      lastError: null,
    }

    const torrc = `${state.home}/torrc`
    const cookie = `${state.home}/data/control_auth_cookie`
    const pidfile = `${state.home}/tor.pid`

    const ownsTunnel = () => pidAlive(pidfile)

    async function start(): Promise<string> {
      if (await portOpen(state.socksPort)) {
        // Something is already listening. It may be a tunnel this plugin
        // started earlier in the same server run (the plugin can be set up
        // more than once), or a stranger. Our pidfile tells them apart:
        // a live process at that pid means the cookie in our home is valid.
        state.running = true
        state.adopted = !(await ownsTunnel())
        return "already listening"
      }

      if (!state.autoStart) {
        state.lastError = `socks port ${state.socksPort} is closed and autoStart is off`
        return "not started"
      }

      await mkdir(join(state.home, "data"), { recursive: true })
      await writeFile(
        torrc,
        [
          `SocksPort ${state.socksPort}`,
          `ControlPort ${state.ctrlPort}`,
          "CookieAuthentication 1",
          `DataDirectory ${join(state.home, "data")}`,
          `Log notice file ${join(state.home, "tor.log")}`,
          "",
        ].join("\n"),
        "utf8",
      )

      const proc = spawn("tor", ["-f", torrc], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      })
      proc.unref()

      if (proc.pid) await writeFile(pidfile, String(proc.pid), "utf8")

      for (let i = 0; i < 40; i++) {
        const r = await sh("grep", ["-q", "Bootstrapped 100%", join(state.home, "tor.log")], 5000)
        if (r.code === 0) break
        await sleep(1500)
      }

      state.running = await portOpen(state.socksPort)
      state.adopted = false
      return state.running ? "started" : "failed to bootstrap"
    }

    async function rotate(): Promise<{ ok: boolean; reason?: string }> {
      if (!(await portOpen(state.ctrlPort))) {
        return { ok: false, reason: `control port 127.0.0.1:${state.ctrlPort} is closed` }
      }

      let raw: Buffer
      try {
        await access(cookie, constants.R_OK)
        raw = await readFile(cookie)
      } catch {
        // The cookie path comes from our config; the tor answering on the port
        // may be a different instance entirely (adopted, or a leftover whose
        // data directory was removed). Say so instead of a vague failure.
        return {
          ok: false,
          reason: `cannot read control cookie at ${cookie} — the tor on port ${state.socksPort} was not started by this plugin`,
        }
      }

      const hex = raw.toString("hex")
      const ok = await sendControl(state.ctrlPort, `AUTHENTICATE ${hex}\r\nSIGNAL NEWNYM\r\nQUIT\r\n`)
      if (!ok) return { ok: false, reason: `control connection to 127.0.0.1:${state.ctrlPort} failed` }
      await sleep(1200)
      return { ok: true }
    }

    async function refresh() {
      if (!(await portOpen(state.socksPort))) {
        state.running = false
        state.exitIP = null
        state.isTor = false
        return
      }
      state.running = true
      const e = await readExit(state)
      state.exitIP = e.ip
      state.isTor = e.isTor
    }

    // bring the tunnel up at plugin load so the first command is already covered
    const bootResult = await start()
    if (state.running) await refresh()

    // ---- shell hook: every command in every session goes through tor ----
    // Provider hosts are read once at load. ctx.provider is not consulted per
    // command; the hook must stay cheap.
    let providerList: readonly unknown[] = []
    try {
      const out = await ctx.provider.list()
      providerList = (Array.isArray(out) ? out : (out as { data?: unknown }).data ?? []) as typeof providerList
    } catch {
      state.lastError = "could not read provider records; falling back to loopback-only NO_PROXY"
    }
    const noProxy = [LOOPBACK_NO_PROXY, ...providerHosts(providerList)].join(",")

    const proxyEnv: Record<string, string> = {
      ALL_PROXY: `socks5h://127.0.0.1:${state.socksPort}`,
      all_proxy: `socks5h://127.0.0.1:${state.socksPort}`,
      HTTP_PROXY: `socks5h://127.0.0.1:${state.socksPort}`,
      http_proxy: `socks5h://127.0.0.1:${state.socksPort}`,
      HTTPS_PROXY: `socks5h://127.0.0.1:${state.socksPort}`,
      https_proxy: `socks5h://127.0.0.1:${state.socksPort}`,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      TORCTL_SOCKS_PORT: String(state.socksPort),
      TORCTL_CTRL_PORT: String(state.ctrlPort),
      TORCTL_HOME: state.home,
    }

    const hookReg = await ctx.shell.hook("create.before", (event) => {
      if (!state.inject) return
      if (!state.running) return
      Object.assign(event.env, proxyEnv)
    })

    // ---- tools ----
    const toolReg = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "tor",
        description: "Tor tunnel state and control for this session",
      })

      editor.add({
        name: "status",
        description:
          "Show whether the session tunnel is up, the current exit IP, and whether egress is really Tor. Use before any network work you want attributed to a different IP.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "tor" },
        execute: async () => {
          await refresh()
          const lines = [
            `state:    ${state.running ? "up" : "down"}`,
            `socks:    127.0.0.1:${state.socksPort}`,
            `control:  127.0.0.1:${state.ctrlPort}`,
            `home:     ${state.home}`,
            `inject:   ${state.inject ? "on" : "off"}`,
            `owner:    ${state.adopted ? "adopted (not started by this plugin)" : "this plugin"}`,
            `exit ip:  ${state.exitIP ?? "<none>"}`,
            `is tor:   ${state.isTor ? "yes" : "no"}`,
            `boot:     ${bootResult}`,
          ]
          if (state.lastError) lines.push(`error:    ${state.lastError}`)
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: "rotate",
        description:
          "Request a fresh Tor circuit so the next requests leave from a different exit IP. Use when a target rate-limits or blocks the current exit.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "tor" },
        execute: async () => {
          const r = await rotate()
          if (!r.ok) return { content: `rotate failed: ${r.reason}` }
          await refresh()
          return { content: `new circuit\n${state.exitIP ?? "<no exit>"} (isTor: ${state.isTor})` }
        },
      })

      editor.add({
        name: "off",
        description:
          "Stop injecting the proxy into shell commands for the rest of this server run. The tunnel stays up; commands just stop using it.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "tor" },
        execute: async () => {
          state.inject = false
          return { content: "proxy injection off — commands now use the default route" }
        },
      })

      editor.add({
        name: "on",
        description: "Resume injecting the proxy into shell commands.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "tor" },
        execute: async () => {
          if (!state.running) await start()
          state.inject = true
          await refresh()
          return { content: `proxy injection on — exit ${state.exitIP ?? "<none>"}` }
        },
      })
    })

    return async () => {
      // Stop routing new commands, but leave tor running: the tunnel is a
      // shared resource that other sessions and later server runs reuse.
      // Stopping it is an explicit action, not a side effect of an unload.
      state.inject = false
      await hookReg.dispose()
      await toolReg.dispose()
    }
  },
})
