import { expect, test } from 'claude-code/testing'

const SNAP = {
  generatedAt: 0,
  plan: 'Ultra',
  cycles: [
    { key: 'seven_day', name: 'wk', label: 'Weekly (all models)', used: 0.61, elapsed: 0.29, pace: 2.1, risk: 0.92, status: 'critical', resetsIn: 4 * 86_400_000, resetsAt: 0, source: 'official' },
    { key: 'seven_day_fable_cap', name: 'fable', label: 'Weekly (Fable, 50% cap)', used: 0.2, elapsed: 0.29, pace: 0.7, risk: 0.01, status: 'ok', resetsIn: 4 * 86_400_000, resetsAt: 0, source: 'derived' },
  ],
  today: { cost: 179, forecast: 397 },
  spike: false,
}

const BAND = {
  plugin: 'ccpulse-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, scroll: { offset: 0, bodyRows: 10 } },
} as const

test('collapsed: one line with usage, risk and reset on terminal and desktop', async ($, on) => {
  const held: Record<string, unknown> = { snap: { ...SNAP, generatedAt: Date.now() }, error: null, isExpanded: false }
  on('state.get', (_, e) => ({ value: { value: held[e.key], version: 1 } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    expect((await ui.find({ type: 'Text', text: /^61%$/ }))?.text).toBe('61%')
    expect((await ui.find({ type: 'Text', text: /92% risk/ }))?.text).toContain('92% risk')
    expect((await ui.find({ type: 'Text', text: /^Weekly$/ }))?.text).toBe('Weekly')
    expect((await ui.find({ type: 'Text', text: /· 4d 0h/ }))?.text).toContain('4d 0h')
    // Low risk is not shouted about.
    expect(await ui.find({ type: 'Text', text: /1% risk/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with no data and no error the band stays out of the way', async ($, on) => {
  on('state.get', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('expanded: an aligned table with pace and a Hide button', async ($, on) => {
  const held: Record<string, unknown> = { snap: { ...SNAP, generatedAt: Date.now() }, error: null, isExpanded: true }
  on('state.get', (_, e) => ({ value: { value: held[e.key], version: 1 } }))
  on('state.set', (_, e) => { held[e.key] = e.value; return { value: { version: 2 } } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    expect((await ui.find({ type: 'Text', text: /^Weekly \(all models\)$/ }))?.text).toBe('Weekly (all models)')
    expect((await ui.find({ type: 'Text', text: /^2\.1×$/ }))?.text).toBe('2.1×')
    expect((await ui.find({ type: 'Text', text: /^92%$/ }))?.text).toBe('92%')
    await ui.unmount()
  }
})

// ---- reaching the CLI on each platform ----
const PLATFORMS = {
  windows: { env: { OS: 'Windows_NT', ComSpec: 'C:\\Windows\\system32\\cmd.exe', USERPROFILE: 'C:\\Users\\me' }, first: ['C:\\Windows\\system32\\cmd.exe', '/d', '/s', '/c', 'ccpulse statusline --json'] },
  macos: { env: { HOME: '/Users/me', SHELL: '/bin/zsh' }, first: ['ccpulse', 'statusline', '--json'], login: ['/bin/zsh', '-lc', 'ccpulse statusline --json'] },
  linux: { env: { HOME: '/home/me' }, first: ['ccpulse', 'statusline', '--json'], login: ['/bin/bash', '-lc', 'ccpulse statusline --json'] },
} as const

for (const [name, p] of Object.entries(PLATFORMS)) {
  test(`${name}: finds ccpulse the way that platform can run it`, async ($, on) => {
    const tried: string[][] = []
    on('env.get', (_, e) => ({ value: (p.env as Record<string, string>)[e.name] }))
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('process.run', (_, e) => {
      tried.push([...e.argv])
      // The plain command is "not found" on a desktop app's PATH; the next way works.
      if (tried.length === 1) return { value: { exitCode: 127, stdout: '', stderr: 'ccpulse: command not found', isStdoutTruncated: false, isStderrTruncated: false } }
      return { value: { exitCode: 0, stdout: JSON.stringify(SNAP), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.command.run({ command: 'pulse', args: '' } as any)
    expect(tried[0]).toEqual([...p.first])
    if ('login' in p) expect(tried[1]).toEqual([...p.login])
    // What the CLI answered is what the band now draws.
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
    expect((await ui.find({ type: 'Text', text: /^61%$/ }))?.text).toBe('61%')
    await ui.unmount()
  })
}
