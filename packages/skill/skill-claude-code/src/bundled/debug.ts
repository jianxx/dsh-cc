/**
 * Ported Claude Code bundled `debug` skill.
 *
 * Source: `~/workspace/github.com/claude-code/skills/bundled/debug.ts`. The
 * original resolves runtime values (the session debug-log path and its tail) at
 * invocation; this port keeps the authored instruction body verbatim, leaving
 * those runtime-injected fragments as literal placeholders for whichever
 * consumer runs the skill.
 *
 * @module
 */

export const name = 'debug'

export const SKILL_MD = `---
name: debug
description: Enable debug logging for this session and help diagnose issues
allowed-tools: Read, Grep, Glob
argument-hint: '[issue description]'
disable-model-invocation: true
user-invocable: true
---

# Debug Skill

Help the user debug an issue they're encountering in this current Claude Code session.

## Session Debug Log

The debug log for the current session is at: \`\${debugLogPath}\`.

For additional context, grep for [ERROR] and [WARN] lines across the full file.

## Issue Description

\${issueDescription}

## Settings

Remember that settings are in:
* user - \${userSettingsPath}
* project - \${projectSettingsPath}
* local - \${localSettingsPath}

## Instructions

1. Review the user's issue description
2. Look for [ERROR] and [WARN] entries, stack traces, and failure patterns across the file
3. Consider launching the \`claude-code-guide\` subagent to understand the relevant Claude Code features
4. Explain what you found in plain language
5. Suggest concrete fixes or next steps
`
