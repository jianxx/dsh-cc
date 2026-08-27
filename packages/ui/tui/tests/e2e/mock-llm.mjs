// Test-only cordis plugin: a scripted LLM adapter on provider route "mock".
// Lets the PTY e2e suite exercise the full agent loop (stream → assemble →
// turn end) with no network and no credentials.
//
// Script behavior, controlled by env:
//   DSH_CC_E2E_LINES=<n>  one-shot: the FIRST call streams n short "e2e line N"
//                          text-deltas (a tall transcript to stress the
//                          renderer), then every later call yields "MOCK OK".
//                          The one-shot lets the overflow scenario assert a
//                          later "ping → MOCK OK" after the flood.
//   (default)              yield "MOCK OK" as one text block, then finish.
//
// Loaded by the e2e harness via an absolute file specifier in the patch YAML;
// not part of any published bundle. Deliberately a plain object implementing
// the LlmAdapter interface (providerInfo / listModels / resolveModel /
// prepareCall / stream) so it does NOT import @deepseek-ai/dsh-llm — that
// import would pull a second dsh-llm + cordis instance from the worktree and
// risk a class/version mismatch with the installed dsh runtime. The registry
// duck-types adapters.

export const name = 'e2e-mock-llm'
export const inject = ['llm']

function makeAdapter() {
  let flooded = false

  async function* stream() {
    yield { blockType: 'text', index: 0, type: 'block-start' }

    const linesEnv = process.env.DSH_CC_E2E_LINES
    if (linesEnv !== undefined && linesEnv.length > 0 && !flooded) {
      flooded = true
      const count = Number.parseInt(linesEnv, 10) || 0
      let full = ''
      for (let i = 1; i <= count; i++) {
        const line = `e2e line ${i}\n`
        full += line
        yield { index: 0, text: line, type: 'text-delta' }
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      yield { block: { text: full, type: 'text' }, index: 0, type: 'block-end' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: count } }
      yield { reason: { kind: 'stop' }, type: 'finish' }
      return
    }

    const text = 'MOCK OK'
    yield { index: 0, text, type: 'text-delta' }
    yield { block: { text, type: 'text' }, index: 0, type: 'block-end' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
    yield { reason: { kind: 'stop' }, type: 'finish' }
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: provider }
    },
    providerRetryPolicy() {
      return undefined
    },
    async listModels(provider) {
      return [{ provider, id: 'e2e-1', name: 'e2e-1' }]
    },
    async resolveModel(provider, model) {
      return { provider, id: model, name: model }
    },
    async prepareCall(provider, model) {
      return {
        model: { provider, id: model, name: model },
        stream: () => stream(),
      }
    },
    stream: () => stream(),
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], makeAdapter())
}
