# dsh-tool-search

English | [中文](README.zh.md)

Deferred tool registration plus a model-facing **ToolSearch** tool that loads heavy tools on demand. A tool that is expensive to load or token-heavy in the prompt can be registered **deferred**: it contributes a name, description, and search hint to a searchable registry, but its real definition stays **out of the model-visible schema and prompt** until the model asks for it.

## Why defer tools

Every visible tool schema costs prompt tokens and, for a heavy capability, load time. Most sessions need only a handful of tools from a large catalog. Deferral carries the *capability metadata* cheaply and loads the material definition only when the model actually summons it — generalizing the `shouldDefer`/ToolSearch mechanism (and the MCP `_meta['anthropic/alwaysLoad']` escape hatch) into the harness's effect-based registry model.

## What it does

[`DeferredToolRegistry`](src/index.ts) is the `ctx.toolSearch` service. A plugin registers a capability deferred:

```ts
ctx.toolSearch.registerDeferred({
  name: 'big_fs_tool',
  description: 'Heavy filesystem capability invoked once per session.',
  searchHint: 'read write edit files',
  alwaysLoad: false,
  activate: () => ctx.tools.register(bigFsToolDefinition), // returns the exact disposer
})
```

The **ToolSearch** model tool then ranks the deferred set against a `query` (`max_results`, default 5) using weighted substring/token matching over name, `searchHint`, and description. On a hit it calls the registration's `activate()` callback — a real `ctx.tools.register()` — so the tool becomes visible to the **next** assembly and then callable exactly like any top-of-prompt tool. `alwaysLoad: true` registers immediately at defer time and is never a deferred candidate.

The design rides the repo's effect conventions:

- **Deferred registration is an effect.** The returned disposer reclaims the deferred entry *and* any activated `ctx.tools` registration together, so a plugin unloading mid-session tears down both.
- **Activation is idempotent.** Re-activating an already-loaded tool is a no-op; re-registration (which would throw on a duplicate name) never happens.
- **Restriction stays authoritative.** `registerDeferred` reserves the tool's name in the `dsh-tools` registry (known but not visible), so a scoped `restrict()` can deny it *before* it loads. ToolSearch checks that gate: a deferred tool a scope denies is **not** activated for that scope, and the result says why.
- **Deferred names never leak into the prompt.** Only activated (`alwaysLoad` or loaded) tools enter the schema; reserved-but-unloaded names are known for restriction/`toolOrder` purposes but never model-visible.

## Model Experience

Turn one, the model sees only `ToolSearch` plus whatever is already loaded (including `alwaysLoad` tools). It searches for a capability by keywords, and the result names the now-available tools. On the next turn those tools are first-class: declare them, call them. Already-loaded tools drop out of the deferred set, so a second search for them is correctly empty.

## Known Limitations and Deferred Work

- **Matching is lexical, not semantic.** Ranking uses weighted substring/token scoring; there is no embedding/vector search. This keeps the seam dependency-free and deterministic, at the cost of synonyms that share no token.
- **Global activation.** Loading happens on the host plane (global registration); a per-agent scope sees a loaded tool only if its restriction admits it. There is no per-conversation discovery history — loading is an in-memory effect, so a re-registered composition starts from the deferred pool again.
