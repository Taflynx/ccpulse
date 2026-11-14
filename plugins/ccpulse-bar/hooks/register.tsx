import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cycle, Snapshot } from '../types'

// ccpulse computes everything (plan meter, learned limits, Monte Carlo risk);
// this mod only draws its compact snapshot above the prompt, on terminal and desktop:
// one line of solid bars by default, an aligned table when expanded.
const snap = atom({ plugin: 'ccpulse-bar', key: 'snap' } as const, null)
const error = atom({ plugin: 'ccpulse-bar', key: 'error' } as const, null)
const isExpanded = atom({ plugin: 'ccpulse-bar', key: 'isExpanded' } as const, false)

const REFRESH_MS = 60_000

/**
 * How to reach the ccpulse CLI, per platform, most direct first. `$.process.run` takes an argv
 * (no shell), which matters in two places:
 * - Windows: npm installs `ccpulse.cmd`, which only a shell resolves, so go through cmd.exe.
 * - macOS/Linux desktop apps: started from the Dock/launcher they do not inherit the shell's PATH
 *   (Homebrew, nvm, volta, ~/.npm-global), so fall back to a login shell that loads it.
 * `CCPULSE_BIN` overrides everything: a command line (`node /path/to/cli.js`) or, for paths with
 * spaces, a JSON array (`["node", "C:\\Program Files\\ccpulse\\dist\\cli.js"]`).
 */
async function candidates($: EngineInterface): Promise<string[][]> {
  const args = ['statusline', '--json']
  const out: string[][] = []
  const bin = (await $.env.get('CCPULSE_BIN'))?.trim()
  if (bin) {
    let argv: string[] | undefined
    if (bin.startsWith('[')) {
      try {
        argv = JSON.parse(bin)
      } catch {
        argv = undefined
      }
    }
    out.push([...(argv ?? bin.split(/\s+/)), ...args])
  }
  const isWindows = (await $.env.get('OS')) === 'Windows_NT' || !!(await $.env.get('ComSpec'))
  if (isWindows) {
    const cmd = (await $.env.get('ComSpec')) || 'cmd.exe'
    out.push([cmd, '/d', '/s', '/c', `ccpulse ${args.join(' ')}`])
    out.push([cmd, '/d', '/s', '/c', `npx --yes ccpulse ${args.join(' ')}`])
    return out
  }
  out.push(['ccpulse', ...args])
  const home = (await $.env.get('HOME')) ?? ''
  const isMac = home.startsWith('/Users/')
  const shell = (await $.env.get('SHELL')) || (isMac ? '/bin/zsh' : '/bin/bash')
  out.push([shell, '-lc', `ccpulse ${args.join(' ')}`])
  out.push([shell, '-lc', `npx --yes ccpulse ${args.join(' ')}`])
  return out
}

let working: string[] | null = null
let inFlight = false

async function refresh($: EngineInterface): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const list = working ? [working] : await candidates($)
    let lastErr = 'ccpulse not found (npm i -g ccpulse, or set CCPULSE_BIN)'
    for (const argv of list) {
      try {
        const r = await $.process.run(argv, { timeoutMs: 60_000 })
        if (r.exitCode !== 0) {
          lastErr = (r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.exitCode}`
          continue
        }
        const data = JSON.parse(r.stdout) as Snapshot
        working = argv
        await update($, snap, () => data)
        await update($, error, () => null)
        return
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
    }
    working = null
    await update($, error, () => lastErr)
  } finally {
    inFlight = false
  }
}

// ---------- formatting ----------

const pct = (v: number) => `${Math.round(v * 100)}%`

function dur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m % 60}m`
}

function money(v: number): string {
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`
}

type Tone = 'error' | 'warning' | 'success'
function tone(c: Cycle): Tone {
  if (c.status === 'critical') return 'error'
  if (c.status === 'warn' || c.status === 'watch') return 'warning'
  return 'success'
}

const nice = (c: Cycle) =>
  c.key === 'five_hour' ? '5-hour' : c.key === 'seven_day' ? 'Weekly' : c.key.endsWith('_cap') ? 'Fable cap' : c.label.replace('Weekly ', '').replace(/[()]/g, '')

/**
 * A solid progress bar in theme colors: the used part in the status color, the rest as a track,
 * and a notch where an even pace through the cycle would be now.
 */
function solidBar(Text: any, c: Cycle, n: number) {
  const fill = Math.round(Math.min(1, Math.max(0, c.used)) * n)
  const at = Math.min(n - 1, Math.max(0, Math.round(c.elapsed * n)))
  const t = tone(c)
  return (
    <Text>
      {Array.from({ length: n }, (_, i) => (
        <Text key={String(i)} backgroundColor={i < fill ? t : 'inactive'} color="#ffffff">
          {i === at ? '│' : ' '}
        </Text>
      ))}
    </Text>
  )
}

const showRisk = (c: Cycle) => c.risk !== undefined && c.risk >= 0.05


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pulse', description: 'Refresh the ccpulse usage bar and show the full status' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))
    return next(e)
  })

  // A finished turn is when usage changed; the CLI caches for 60 s, so this stays cheap.
  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    working = null
    await refresh($)
    await update($, isExpanded, () => true)
    const s = await read($, snap)
    const err = await read($, error)
    if (!s) return { text: err ? `ccpulse: ${err}` : 'ccpulse: no data yet.' }
    return { text: `Usage bar expanded (${s.plan}). Press Hide to fold it back to one line.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, snap)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!s) {
      const err = await read($, error)
      return err ? <Text dimColor>ccpulse · {err}</Text> : next(e)
    }
    const age = Date.now() - s.generatedAt
    const open = await read($, isExpanded)
    const toggle = () => update($, isExpanded, v => !v)

    // ---- one quiet line ----
    if (!open) {
      return (
        <Box flexDirection="row" flexWrap="nowrap" columnGap={3} overflow="hidden">
          {s.cycles.map(c => (
            <Box key={c.key} flexDirection="row" columnGap={1} flexShrink={0}>
              <Text dimColor>{nice(c)}</Text>
              {solidBar(Text, c, 14)}
              <Text color={tone(c)} bold>
                {pct(c.used)}
              </Text>
              <Text dimColor>
                {showRisk(c) ? `${pct(c.risk!)} risk · ` : ''}
                {dur(c.resetsIn - age)}
              </Text>
            </Box>
          ))}
          <Box flexGrow={1} />
          <Button key="expand" label="▸ Details" onPress={toggle} dimColor />
        </Box>
      )
    }

    // ---- expanded: an aligned table ----
    const W = { name: 24, bar: 22, used: 7, cycle: 8, pace: 7, risk: 7, reset: 10 }
    const cell = (w: number, child: any, right = false) => (
      <Box width={w} flexShrink={0} justifyContent={right ? 'flex-end' : 'flex-start'}>
        {child}
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {cell(W.name, <Text dimColor>Limit</Text>)}
          {cell(W.bar, <Text dimColor>│ = even pace now</Text>)}
          {cell(W.used, <Text dimColor>used</Text>, true)}
          {cell(W.cycle, <Text dimColor>cycle</Text>, true)}
          {cell(W.pace, <Text dimColor>pace</Text>, true)}
          {cell(W.risk, <Text dimColor>risk</Text>, true)}
          {cell(W.reset, <Text dimColor>resets in</Text>, true)}
        </Box>
        {s.cycles.map(c => (
          <Box key={c.key} flexDirection="row" columnGap={1}>
            {cell(W.name, <Text>{c.label}</Text>)}
            {cell(W.bar, solidBar(Text, c, W.bar - 2))}
            {cell(W.used, <Text color={tone(c)} bold>{pct(c.used)}</Text>, true)}
            {cell(W.cycle, <Text dimColor>{pct(c.elapsed)}</Text>, true)}
            {cell(W.pace, <Text color={c.pace !== undefined && c.pace >= 1.25 ? tone(c) : undefined} dimColor={c.pace === undefined || c.pace < 1.05}>
                {c.pace !== undefined && c.elapsed >= 0.05 ? `${c.pace.toFixed(1)}×` : '–'}
              </Text>, true)}
            {cell(W.risk, <Text color={showRisk(c) ? tone(c) : undefined} dimColor={!showRisk(c)}>
                {c.risk !== undefined ? pct(c.risk) : '–'}
              </Text>, true)}
            {cell(W.reset, <Text dimColor>{dur(c.resetsIn - age)}</Text>, true)}
          </Box>
        ))}
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          <Text dimColor>
            {s.plan} · today {money(s.today.cost)} → {money(s.today.forecast)} API-equiv.
            {s.spike ? ' · unusual spike in the last 2h' : ''}
          </Text>
          <Box flexGrow={1} />
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} dimColor />
          <Button key="collapse" label="▾ Hide" onPress={toggle} dimColor />
        </Box>
      </Box>
    )
  })
}
