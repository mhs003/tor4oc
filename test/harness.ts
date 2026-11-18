// Direct harness for tor4oc's setup().
//
// Drives the plugin with a fake ctx and asserts what the shell hook injects.
// This tests the plugin code itself, independent of the OpenCode server.
//
//   node --experimental-strip-types test/harness.ts
//
// Node 26 strips types natively, so no build step is needed.

import { mkdtempSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.ts"

type Env = Record<string, string | undefined>
type HookFn = (event: {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Env
}) => void | Promise<void>
type Execute = (input: unknown, ctx: unknown) => Promise<{ content?: string }>

const SOCKS = 19050
const CTRL = 19051

const results: string[] = []
const ok = (m: string) => results.push("PASS  " + m)
const bad = (m: string) => results.push("FAIL  " + m)
const eq = (label: string, got: unknown, want: unknown) =>
  got === want ? ok(`${label} = ${JSON.stringify(got)}`) : bad(`${label} = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)

const home = mkdtempSync(join(tmpdir(), "tor4oc-harness-"))

const hooks: Record<string, HookFn> = {}
const tools: Record<string, Execute> = {}

const ctx = {
  app: { version: "harness" },
  options: { home, socksPort: SOCKS, ctrlPort: CTRL, autoStart: false, inject: true },
  shell: {
    hook: async (name: string, fn: HookFn) => {
      hooks[name] = fn
      return { dispose: async () => void delete hooks[name] }
    },
  },
  tool: {
    transform: async (cb: (editor: unknown) => void) => {
      let prefix = ""
      const editor = {
        namespace: (n: { name: string }) => {
          prefix = n.name + "_"
        },
        add: (t: { name: string; execute: Execute }) => {
          tools[prefix + t.name] = t.execute
        },
      }
      cb(editor)
      return { dispose: async () => {} }
    },
  },
} as never

const fire = async (command = "curl -sS https://example.com"): Promise<Env> => {
  const env: Env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME }
  const hook = hooks["create.before"]
  if (!hook) throw new Error("create.before hook not registered")
  await hook({ command, cwd: home, timeout: 30_000, shell: "/usr/bin/bash", env })
  return env
}

async function main() {
  // autoStart is off, so setup() does not spawn a real tor. Port is closed.
  const dispose = await plugin.setup(ctx as never)

  // -- registration -------------------------------------------------------
  if (hooks["create.before"]) ok("hook registered: create.before")
  else bad("hook NOT registered: create.before")

  for (const t of ["tor_status", "tor_rotate", "tor_off", "tor_on"]) {
    if (tools[t]) ok(`tool registered: ${t}`)
    else bad(`tool NOT registered: ${t} — got ${JSON.stringify(Object.keys(tools))}`)
  }

  // -- tunnel down --------------------------------------------------------
  const down = await fire()
  eq("down: ALL_PROXY untouched", down.ALL_PROXY, undefined)
  eq("down: existing PATH preserved", down.PATH, "/usr/bin:/bin")

  // -- bring a fake socks listener up, then tor_on ------------------------
  const srv = createServer((s) => s.end())
  await new Promise<void>((r) => srv.listen(SOCKS, "127.0.0.1", () => r()))

  try {
    const on = await tools["tor_on"]({})
    // tor_on calls refresh(), which probes check.torproject.org; that will fail
    // because our fake listener closes every socket. That is fine — what
    // matters is that state.running became true after the port probe.
    if (typeof on.content === "string") ok("tor_on returns content")
    else bad("tor_on returned no content")

    const up = await fire()
    const want = `socks5h://127.0.0.1:${SOCKS}`
    for (const k of ["ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      eq(`up: ${k}`, up[k], want)
    }
    eq("up: TORCTL_HOME", up.TORCTL_HOME, home)
    eq("up: TORCTL_SOCKS_PORT", up.TORCTL_SOCKS_PORT, String(SOCKS))
    eq("up: TORCTL_CTRL_PORT", up.TORCTL_CTRL_PORT, String(CTRL))
    if (typeof up.NO_PROXY === "string" && up.NO_PROXY.includes("127.0.0.1") && up.NO_PROXY.includes("localhost"))
      ok("up: NO_PROXY covers loopback")
    else bad(`up: NO_PROXY = ${JSON.stringify(up.NO_PROXY)}`)

    // -- tor_off ----------------------------------------------------------
    await tools["tor_off"]({})
    const off = await fire()
    eq("off: ALL_PROXY not injected", off.ALL_PROXY, undefined)
  } finally {
    srv.close()
  }

  // -- status while injected off -----------------------------------------
  const status = await tools["tor_status"]({})
  if (typeof status.content === "string" && status.content.includes("inject:")) ok("tor_status reports state")
  else bad("tor_status content malformed")

  // A tunnel we did not start (no pidfile, no cookie) must report itself as
  // adopted and must explain why rotate cannot work instead of failing quietly.
  if (typeof status.content === "string" && status.content.includes("owner:    adopted"))
    ok("owner reported as adopted when no pidfile exists")
  else bad(`owner line: ${JSON.stringify(status.content)}`)

  const rot = await tools["tor_rotate"]({})
  const text = String(rot.content ?? "")
  if (
    text.startsWith("rotate failed: control port") ||
    text.startsWith("rotate failed: cannot read control cookie")
  )
    ok("rotate failure names its cause")
  else bad(`rotate message: ${text}`)

  // -- dispose ------------------------------------------------------------
  await dispose?.()
  if (hooks["create.before"] === undefined) ok("dispose: hook unregistered")
  else bad("dispose: hook still registered after dispose")

  // -- provider hosts must never be tunnelled ------------------------------
  {
    const h: Record<string, HookFn> = {}
    const c = {
      app: { version: "harness" },
      options: { home: mkdtempSync(join(tmpdir(), "tor4oc-np-")), socksPort: SOCKS, ctrlPort: CTRL, autoStart: false },
      shell: {
        hook: async (n: string, fn: HookFn) => {
          h[n] = fn
          return { dispose: async () => void delete h[n] }
        },
      },
      tool: {
        transform: async (cb: (e: unknown) => void) => {
          let p = ""
          const t: Record<string, Execute> = {}
          cb({
            namespace: (n: { name: string }) => { p = n.name + "_" },
            add: (x: { name: string; execute: Execute }) => { t[p + x.name] = x.execute },
          })
          ;(c as any).__tools = t
          return { dispose: async () => {} }
        },
      },
    }
    const d = await plugin.setup(c as never)
    const srv3 = createServer((x) => x.end())
    await new Promise<void>((r) => srv3.listen(SOCKS, "127.0.0.1", () => r()))
    await (c as any).__tools["tor_status"]({}) // refresh so state knows the port is up
    const env: Env = {}
    // port is up, inject defaults on: the hook should fire
    await h["create.before"]?.({ command: "curl x", cwd: c.options.home, timeout: 1000, shell: "bash", env })
    srv3.close()
    await d?.()
    const np = String(env.NO_PROXY ?? "")
    if (env.ALL_PROXY) ok("default inject: on with a live tunnel")
    else bad("default inject: nothing injected")
    if (np.includes("api.river.ai")) ok("NO_PROXY excludes provider API host")
    else bad(`NO_PROXY = ${np}`)
    if (np.includes("127.0.0.1")) ok("NO_PROXY still covers loopback")
    else bad(`NO_PROXY lacks loopback: ${np}`)
  }

  console.log(results.join("\n"))
  const failed = results.filter((r) => r.startsWith("FAIL")).length
  console.log(`\n${results.length - failed} passed, ${failed} failed   (home: ${home})`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error("harness crashed:", e)
  process.exit(2)
})
