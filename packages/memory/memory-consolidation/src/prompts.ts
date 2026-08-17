/**
 * Prompt builders for the extraction and dream forks. Both are pure text
 * assembly so they are unit-testable and stable model-visible contracts.
 * @module @jianxx/dsh-cc-memory-consolidation/prompts
 */

import { MEMORY_AGENT_TOOLS } from './tools.ts'

/** The always-loaded index filename (mirrors `dsh-memory`'s export). */
const ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * Build the <system-reminder> user prompt that extracts durable facts from a
 * batch of recent model-visible messages into topic files.
 * @param surfaceMessageCount - how many model-visible surface events (user/message
 *   + assistant/message + tool/result) this run reviews.
 * @param memoryDir - the memory directory to write into.
 * @param existingIndex - a prior topic manifest, if any.
 * @returns the prompt text.
 */
export function buildExtractionPrompt(
  surfaceMessageCount: number,
  memoryDir: string,
  existingIndex: string,
): string {
  return [
    `Extract durable memories from the last ${surfaceMessageCount} messages of this conversation and save them to the memory directory \`${memoryDir}\`.`,
    'A memory is a fact or preference that will be useful in FUTURE conversations, not ephemeral task detail.',
    'Write each memory to its own `.md` topic file with YAML frontmatter: name, description, and type (`user` | `feedback` | `project` | `reference`).',
    `Add or update a one-line pointer in \`${ENTRYPOINT_NAME}\` for each topic (.md). Do not put memory bodies in the index.`,
    'Never duplicate a topic listed under "Existing topics" below; prefer updating the matching topic file instead of creating a new one.',
    `You may use only: ${MEMORY_AGENT_TOOLS.join(', ')}. Read and write only inside \`${memoryDir}\`.`,
    'The conversation to review is already in your context — do not open files or browse directories outside the memory directory.',
    'If the reviewed messages contain no new durable fact worth remembering, write nothing at all (no files, no index update) and finish immediately.',
    '',
    'Existing topics:',
    existingIndex.length > 0 ? existingIndex : '(none yet)',
  ].join('\n')
}

/**
 * Build the <system-reminder> user prompt that reviews past sessions and
 * consolidates them into the memory directory.
 * @param memoryDir - the memory directory to rewrite.
 * @param transcriptDir - the directory holding past session transcripts.
 * @param sessionHints - a list of session ids to review.
 * @returns the prompt text.
 */
export function buildConsolidationPrompt(
  memoryDir: string,
  transcriptDir: string,
  sessionHints: readonly string[],
): string {
  return [
    `You are consolidating persistent memory from past sessions. Review the sessions listed below (transcripts in \`${transcriptDir}\`), distill durable facts, and rewrite \`${memoryDir}\`.`,
    'The memory directory contains MEMORY.md (an index of topic files) and topic `.md` files with YAML frontmatter (name, description, type).',
    `Rewrite \`${ENTRYPOINT_NAME}\` to be a concise index (one line per topic) and keep topic files organized by semantic topic, not chronology.`,
    'Remove memories that are wrong or outdated. Do not drop a fact that is still load-bearing.',
    `You may use only: ${MEMORY_AGENT_TOOLS.join(', ')}. Write only inside \`${memoryDir}\`.`,
    '',
    'Sessions since the last consolidation:',
    ...sessionHints.map(id => `- ${id}`),
  ].join('\n')
}
