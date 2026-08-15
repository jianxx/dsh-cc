# dsh-claude-code-agents

English | [中文](README.zh.md)

Load Claude Code's `.claude/agents/*.md` and `*.json` sub-agent definitions as dsh agent presets. The package is a pure, filesystem-backed translation: it discovers the user and project layers, parses and validates each agent file, and returns one typed [`AgentDefinition`](./src/types.ts) per agent — no harness runtime is involved, so the loader can be reused by a Claude Code plugin loader alongside this preset package and consumed however a deployment wires it up.

## What it does

- **Two layers, nearest wins.** The project layer is the nearest `.claude/agents` directory found by walking up from the project root; the user layer is the author's own `~/.claude/agents`. A definition is keyed by its file basename, and the project layer shadows the user layer on a name collision.
- **Two formats.** A `.md` file's YAML frontmatter supplies the fields and its markdown body (or the `prompt` frontmatter override) supplies the system prompt. A `.json` file is a single object whose `prompt` field is the system prompt.
- **Loud failures.** Every bad known frontmatter value throws at load time with the file path and field name, so a broken agent is fixed rather than silently degraded. Unknown fields are ignored, so a definition authored against a newer Claude Code release ports to the supported subset.
- **Field translation.** `description` becomes the when-to-use guide; `tools`/`disallowedTools` compile to one effective `allow`/`deny` tool restriction whose names intersect (a name in both lists is denied); `model` (with the `inherit` sentinel normalized), `effort`, `permissionMode`, `maxTurns`, `initialPrompt`, `background`, `memory`, `skills`, `mcpServers`, `hooks`, and `isolation` are all carried through.

## API

- `loadClaudeCodeAgents(root, options?): Promise<AgentDefinition[]>` The project layer resolved by walking up from `root`, shadowing the user layer; `options.userDir` overrides the user `.claude/agents` directory (useful for a harness with a non-default home and for hermetic tests). Throws on the first unparsable agent file.
- `parseAgentMarkdown(path, text, source): AgentDefinition` and `parseAgentJson(path, text, source): AgentDefinition` Parse one in-memory file; useful for unit tests and non-directory inputs.
- `splitFrontmatter(text): ParsedMarkdown` Split the leading YAML block out of a markdown string.
- `discoverAgents(projectRoot, userDir?): Promise<AgentDefinition[]>` The layer merge without the home-dir default.
- `loadAgentsDir(dir, source): Promise<AgentDefinition[]>` and `findProjectAgentsDir(start): Promise<string | undefined>` The per-directory scan and the upward walk.
- `resolveToolRestriction(tools, disallowedTools): ToolRestriction | undefined` and `normalizeModel(model): string | undefined` The pure restriction-merge and model-normalization helpers, exported for reuse and for testing.

`AgentDefinition` carries `agentType` (the file basename), `whenToUse`, `systemPrompt`, `source` (`user` | `project`), `baseDir`, `filename`, and the translated optional fields. The `toolRestriction` value is structurally identical to [`dsh-tools`](../../core/tools/README.md)'s `ToolRestriction`, so a consumer can hand it to a scoped `ctx.tools.restrict()` unchanged.

## Design

The loader is deliberately integration-free. It produces typed definitions and leaves consumption — a scoped tool restriction, a request rewrite, a permission selection — to the caller, so the model-facing parts stay reusable without dragging in the harness runtime. This mirrors [`agent-presets`](../../preset/agent-presets/README.md)'s philosophy of a self-contained vocabulary feeding an explicit consumer, rather than hiding a defaulting step inside the loader.
