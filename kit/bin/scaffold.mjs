#!/usr/bin/env node
// nuxt-base kit generator. Pure: writes only under --dir; never runs npm/git, never registers anything, knows no infra.
// Contract (shared with the `ai scaffold` wrapper): see kit/README.md.
import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { cmdAdd, cmdCheck, cmdList, cmdNew, cmdUpdate } from '../lib/commands.mjs'
import { EXIT, KitError, usageError } from '../lib/errors.mjs'
import { loadKit } from '../lib/kit.mjs'

const USAGE = `usage:
  scaffold new <name> --kind nuxt-app|api|fullstack [--with a,b,c] [--db sqlite|mysql]
           [--deploy cf-pages|container|pm2] [--port N] [--api-port N] --dir <target> [--context ctx.json] [--dry-run] [--json]
  scaffold add resource|page|job <name> [--dir <project>] [--json]
  scaffold check [<dir>] [--json]      exit 0 clean, 1 drift (names the kit version + commit it compared against)
  scaffold update [<dir>] [--json]     re-copy locked files + bump the layer tag; prints the by-hand notes of UPGRADING.md
  scaffold list [--json]
exit codes: 0 ok, 1 drift (check), 2 usage, 3 target dir not empty, 4 unknown/incompatible kind, module or preset,\n            70 internal error (a kit bug — never reported as drift)`

function port(value, flag) {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw usageError(`${flag} must be a port number (1-65535)`)
  return n
}

function parse(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        kind: { type: 'string' },
        with: { type: 'string' },
        db: { type: 'string' },
        deploy: { type: 'string' },
        port: { type: 'string' },
        'api-port': { type: 'string' },
        dir: { type: 'string' },
        context: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    throw usageError(e.message)
  }
  return { flags: parsed.values, args: parsed.positionals }
}

function readContext(file) {
  if (!file) return {}
  if (!existsSync(file)) throw usageError(`--context file not found: ${file}`)
  try {
    const ctx = JSON.parse(readFileSync(file, 'utf8'))
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) throw new Error('must be a JSON object')
    return ctx
  } catch (e) {
    throw usageError(`--context ${file}: ${e.message}`)
  }
}

async function run(argv) {
  const { flags, args } = parse(argv)
  const [command, ...rest] = args
  if (flags.help || !command) return { exit: command || flags.help ? EXIT.OK : EXIT.USAGE, text: USAGE }
  const kit = loadKit(process.env.AI_KIT_DIR || undefined)
  const max = (n) => { if (rest.length > n) throw usageError(`${command}: unexpected argument "${rest[n]}"`) }
  switch (command) {
    case 'new':
      max(1)
      return cmdNew(kit, {
        name: rest[0],
        kind: flags.kind,
        with: (flags.with ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        db: flags.db,
        deploy: flags.deploy,
        port: port(flags.port, '--port'),
        apiPort: port(flags['api-port'], '--api-port'),
        dir: flags.dir,
        context: readContext(flags.context),
        dryRun: !!flags['dry-run'],
      })
    case 'add':
      max(2)
      return cmdAdd(kit, { type: rest[0], name: rest[1], dir: flags.dir })
    case 'check':
      max(1)
      return cmdCheck(kit, { dir: rest[0] ?? flags.dir })
    case 'update':
      max(1)
      return cmdUpdate(kit, { dir: rest[0] ?? flags.dir })
    case 'list':
      max(0)
      return cmdList(kit)
    default:
      throw usageError(`unknown command "${command}"`)
  }
}

const against = (version, kit) => `kit ${version}${kit.commit ? ` @ ${kit.commit.slice(0, 7)}` : ''}${kit.unreleased ? ', unreleased changes' : ''}`

function text(result) {
  const lines = []
  if (result.files && result.kind) {
    lines.push(`${result.dryRun ? 'would scaffold' : 'scaffolded'} ${result.name} (${result.kind}; modules ${result.modules.join(', ')}; deploy ${result.deploy ?? 'none'}) -> ${result.dir}`)
    lines.push(`${result.files.length} files, ${result.locked.length} locked`, 'next:', ...result.next.map((n) => `  ${n}`))
  } else if (result.drift) {
    // Always: which kit this was compared against — version, commit (when the kit dir is a git checkout), released or not.
    lines.push(`${result.clean ? 'clean' : 'drift'} (${against(result.kit.current, result.kit)})${result.clean ? '' : ':'}`)
    for (const d of result.drift) lines.push(`  ${d.reason}  ${d.path}`)
    if (result.layer?.behind) lines.push(`  layer-behind  ${result.layer.current} -> ${result.layer.latest}`)
    if (result.unreleased.length) {
      lines.push(`  kit has unreleased changes — ${result.unreleased.length} locked file(s) differ from this kit's working tree, not from a release (not project drift):`)
      for (const d of result.unreleased) lines.push(`    ${d.reason}  ${d.path}`)
    }
    if (result.kit.note) lines.push(`  note: ${result.kit.note}`)
    for (const w of result.warnings ?? []) lines.push(`  warning: ${w}`)
  } else if (result.updated) {
    lines.push(`updated ${result.updated.length} locked file(s)${result.layer ? `, layer ${result.layer.from} -> ${result.layer.to}` : ''} (${against(result.kit.to, result.kit)})`)
    for (const p of result.updated) lines.push(`  ${p}`)
    for (const p of result.orphaned) lines.push(`  no longer locked by the kit (left in place): ${p}`)
    for (const section of result.notes) {
      lines.push(`by hand — kit ${section.from} -> ${section.to} (app-owned files are never rewritten; kit/UPGRADING.md):`)
      for (const item of section.items) lines.push(`  - ${item}`)
    }
    if (result.kit.note) lines.push(`  note: ${result.kit.note}`)
    for (const w of result.warnings) lines.push(`  warning: ${w}`)
  } else if (result.kinds) {
    lines.push(`kit ${result.kitVersion}`, `kinds: ${result.kinds.map((k) => k.name).join(', ')}`)
    for (const m of result.modules) lines.push(`module ${m.name.padEnd(10)} ${m.status.padEnd(8)} kinds: ${m.kinds.join(', ')}${m.requires.length ? `  requires: ${m.requires.join(', ')}` : ''}`)
    for (const p of result.deploy) lines.push(`deploy ${p.name.padEnd(10)} kinds: ${p.kinds.join(', ')}`)
  } else if (result.type) {
    lines.push(`added ${result.type} ${result.name}:`, ...result.files.map((f) => `  ${f}`), ...(result.patched ?? []).map((f) => `  ${f} (edited)`))
    if (result.next?.length) lines.push('next:', ...result.next.map((n) => `  ${n}`))
  }
  return lines.join('\n')
}

const json = process.argv.includes('--json')
try {
  const { exit, result, text: plain } = await run(process.argv.slice(2))
  if (plain) (exit === EXIT.OK ? console.log : console.error)(plain)
  else console.log(json ? JSON.stringify(result, null, 2) : text(result))
  process.exitCode = exit
} catch (e) {
  if (!(e instanceof KitError)) {
    // A bug in the kit or in a generator module — never exit 1 (that means drift).
    if (json) console.log(JSON.stringify({ ok: false, code: 'internal', message: String(e?.message ?? e) }, null, 2))
    console.error(e?.stack ?? e)
    process.exit(EXIT.INTERNAL)
  }
  if (json) console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }, null, 2))
  else console.error(`scaffold: ${e.message}${e.exit === EXIT.USAGE ? `\n\n${USAGE}` : ''}`)
  process.exitCode = e.exit
}
