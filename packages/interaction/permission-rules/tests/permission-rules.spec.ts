import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@jianxx/dsh-cc-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE, foldPermissionMode, type Config } from '@jianxx/dsh-cc-permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

const testToolSignal = new AbortController().signal

/** Writable memory provider for the permission/settings lifecycle specs. */
class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  ctx.on('approval/request', async () => 'allowed-once')
  await ctx.plugin(PermissionRules, {
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
    bashToolName: 'Bash',
    ...config,
  })
  // A fake Bash tool reading a command string.
  ctx.tools.register(defineContentToolFixture({
    name: 'Bash',
    description: 'shell',
    parameters: { command: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
  }))
  // A fake file-edit tool reading a file path.
  ctx.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'edit file',
    parameters: { file_path: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
  }))
  // A fake read-only tool.
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'read file',
    parameters: { file_path: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `read:${(args as { file_path: string }).file_path}` }] },
  }))
  return ctx
}

function exec(name: string, args: unknown, agent?: Agent): ToolExecutionInput {
  return {
    signal: testToolSignal,
    callId: CallId('c1'),
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
  }
}

function text(result: ToolExecutionResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

function openTurnAgent(id: string): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { id, session } as unknown as Agent
}

/** An agent whose session carries a working directory (enables the escape check). */
function openAgentWithCwd(id: string, cwd: string): Agent {
  const session = Session.create(SessionId(id), undefined, {
    version: 0,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd,
  })
  session.append('turn/start', { turn: 1 })
  return { id, session } as unknown as Agent
}

describe('plugin pre-execute decisions', () => {
  it('allows a call with no matching rule', async () => {
    const ctx = await mount()
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:ls')
  })

  it('denies a whole-tool deny rule', async () => {
    const ctx = await mount({ rules: { deny: ['Bash'] } })
    const result = await ctx.tools.execute(exec('Bash', { command: 'anything' }))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/denied by permission rule Bash \[config\]/)
  })

  it('denies a content prefix deny rule', async () => {
    const ctx = await mount({ rules: { deny: ['Bash(rm -rf)'] } })
    const ok = await ctx.tools.execute(exec('Bash', { command: 'echo hi' }))
    expect(ok.isError).toBe(false)
    const denied = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /tmp/x' }))
    expect(denied.isError).toBe(true)
    expect(text(denied)).toMatch(/Bash\(rm -rf\)/)
  })

  it('routes a whole-tool ask through approval and runs on allowed-once', async () => {
    const ctx = await mount({ rules: { ask: ['Bash'] } })
    const agent = openTurnAgent('ask-agent')
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:ls')
  })

  it('denies a whole-tool ask without an approval channel (fail closed)', async () => {
    const ctx = await mount({ rules: { ask: ['Bash'] } })
    // No agent in the input: the approval seam cannot route, so it denies.
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }))
    expect(result.isError).toBe(true)
  })
})

describe('bypass-immune guards', () => {
  it('denies a bypass-immune match even under bypassPermissions mode', async () => {
    const ctx = await mount({ rules: { bypassImmune: ['edit(.git*)'] } })
    const agent = openTurnAgent('imm')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('edit', { file_path: '.git/config' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/bypass-immune/)
  })

  it('allows a non-matching subject under bypassPermissions mode', async () => {
    const ctx = await mount({ rules: { bypassImmune: ['edit(.git*)'] } })
    const agent = openTurnAgent('ok')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('edit', { file_path: 'src/main.ts' }, agent))
    expect(result.isError).toBe(false)
  })

  it('enforces the guard even when no pre-execute rule denies', async () => {
    const ctx = await mount({ rules: { bypassImmune: ['edit(.git*)'] } })
    const result = await ctx.tools.execute(exec('edit', { file_path: '.git/config' }))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/bypass-immune/)
  })
})

describe('modes via the plugin', () => {
  it('acceptEdits auto-allows a file-edit call with no rule', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('ae')
    ctx.permissionRules.setMode(agent, 'acceptEdits')
    const result = await ctx.tools.execute(exec('edit', { file_path: 'a.ts' }, agent))
    expect(result.isError).toBe(false)
  })

  it('plan mode auto-allows a read-only call (no rule)', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('plan')
    agent.session.append('plan/mode', { active: true })
    const result = await ctx.tools.execute(exec('read', { file_path: 'a.ts' }, agent))
    expect(result.isError).toBe(false)
  })

  it('bypassPermissions allows a denied tool', async () => {
    const ctx = await mount({ rules: { deny: ['Bash(rm -rf)'] } })
    const agent = openTurnAgent('bypass')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /tmp/x' }, agent))
    expect(result.isError).toBe(false)
  })
})

describe('settings config and hot reload', () => {
  it('merges settings rules with config rules by source priority', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    // no approval service needed here — all cases are allow/deny.
    await ctx.plugin(PermissionRules, { rules: { deny: ['Bash(npm install)'] } })
    ctx.tools.register(defineContentToolFixture({
      name: 'Bash',
      description: 'shell',
      parameters: { command: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
    }))
    // config denies the prefix; settings (higher priority) allows it.
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, {
      allow: ['Bash(npm install)'],
    })
    const result = await ctx.tools.execute(exec('Bash', { command: 'npm install --save x' }))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:npm install --save x')
  })

  it('hot-reloads on settings change (old listener re-reads merged state)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(PermissionRules)
    ctx.tools.register(defineContentToolFixture({
      name: 'Bash',
      description: 'shell',
      parameters: { command: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
    }))
    const before = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /tmp/x' }))
    expect(before.isError).toBe(false)

    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, {
      deny: ['Bash(rm -rf)'],
    })
    const after = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /tmp/x' }))
    expect(after.isError).toBe(true)
    expect(text(after)).toMatch(/Bash\(rm -rf\)/)
  })

  it('fails loud when settings carry a malformed rule', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(PermissionRules)
    await expect(ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, {
      deny: ['Bash(unclosed'],
    })).rejects.toThrow(TypeError)
  })
})

describe('session mode overrides (durable)', () => {
  it('applies the latest setMode and leaves other sessions at the deployment default', async () => {
    const ctx = await mount({ rules: { deny: ['edit(/tmp/private*)'] } })
    const agent = openTurnAgent('one')
    const other = openTurnAgent('two')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    // bypassPermissions overrides the content-deny for the first session…
    const allowed = await ctx.tools.execute(exec('edit', { file_path: '/tmp/private/x' }, agent))
    expect(allowed.isError).toBe(false)
    // …while another session stays at the default mode and remains denied.
    const denied = await ctx.tools.execute(exec('edit', { file_path: '/tmp/private/x' }, other))
    expect(denied.isError).toBe(true)
  })

  it('records setMode as a permission/mode event and survives resume', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('durable')
    ctx.permissionRules.setMode(agent, 'acceptEdits')

    // The live log carries the durable mode override.
    const events = agent.session.events
    expect(events.some(event => event.type === 'permission/mode'
      && (event.data as { mode?: string }).mode === 'acceptEdits')).toBe(true)
    expect(foldPermissionMode(events)).toBe('acceptEdits')

    // Simulate resume: rebuild the session FROM the persisted event log and
    // confirm the override is still effective on the reloaded session.
    const reloaded = Session.create(SessionId('durable-reloaded'), Object.freeze([...events]))
    expect(foldPermissionMode(reloaded.events)).toBe('acceptEdits')
  })
})

describe('risk-classifier escalation', () => {
  it('hard-denies a catastrophic command in every mode, including bypassPermissions', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('high-bypass')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/risk classifier/)
  })

  it('hard-denies a protected-file write', async () => {
    const ctx = await mount()
    const agent = openAgentWithCwd('high-file', '/work')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/work/.bashrc' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/risk classifier/)
  })

  it('allows an out-of-scope write under bypassPermissions (MEDIUM → allow)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const asked: unknown[] = []
    ctx.on('approval/request', async request => { asked.push(request); return 'allowed-once' })
    await ctx.plugin(PermissionRules, { fileEditTools: ['edit'], readOnlyTools: ['read'], bashToolName: 'Bash' })
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit file',
      parameters: { file_path: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
    }))

    const agent = openAgentWithCwd('medium-bypass', '/work')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/tmp/out.txt' }, agent))
    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
  })

  it('asks on an out-of-scope write under default mode (MEDIUM → ask)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const asked: unknown[] = []
    ctx.on('approval/request', async request => { asked.push(request); return 'allowed-once' })
    await ctx.plugin(PermissionRules, { fileEditTools: ['edit'], readOnlyTools: ['read'], bashToolName: 'Bash' })
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit file',
      parameters: { file_path: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
    }))

    const agent = openAgentWithCwd('medium-default', '/work')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/tmp/out.txt' }, agent))
    expect(asked).toHaveLength(1)
    expect(result.isError).toBe(false)
  })

  it('skips the classifier stage when classifierEnabled is false', async () => {
    const ctx = await mount({ classifierEnabled: false })
    const agent = openTurnAgent('disabled')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    // The catastrophic command is no longer hard-denied once the stage is off.
    const result = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /' }, agent))
    expect(result.isError).toBe(false)
  })
})
