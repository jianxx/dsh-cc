import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion, type FsDirEntry, type FsEditRequest, type FsEditOutcome, type FsInfo, type FsPathInfo, type FsTarget, type FsWriteIntent, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'

/** An in-memory `ctx.fs` provider for memory tests. */
export class FakeMemoryFs extends FileSystem {
  constructor(ctx: Context, private backing: Map<string, string> = new Map()) {
    super(ctx)
  }

  override async resolve(path: string): Promise<FsTarget> {
    if (path === '/root') {
      return { targetKey: FsTargetKey('/root'), displayPath: '/root' }
    }
    return { targetKey: FsTargetKey(path), displayPath: path }
  }
  override processPath(target: FsTarget): string { return String(target.targetKey) }
  override fileUrl(target: FsTarget): string { return `file://${String(target.targetKey)}` }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.targetKey === parent.targetKey || String(child.targetKey).startsWith(`${String(parent.targetKey)}/`)
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.backing.get(String(target.targetKey))
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async lstat(path: string): Promise<FsPathInfo | undefined> {
    const content = this.backing.get(path)
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async readText(target: FsTarget): Promise<string> {
    const content = this.backing.get(String(target.targetKey))
    if (content === undefined) throw new FsError(`not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    return content
  }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = await this.readText(target)
    return (async function* () { yield content })()
  }
  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(await this.readText(target))
    if (bytes.length > maxBytes) throw new FsError(`too large: ${target.displayPath}`, 'FS_TOO_LARGE')
    return bytes
  }

  override async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    const root = String(target.targetKey)
    const entries: FsDirEntry[] = []
    for (const key of this.backing.keys()) {
      if (!key.startsWith(`${root}/`)) continue
      const name = key.slice(root.length + 1)
      if (name.includes('/')) continue
      entries.push({
        name,
        type: 'file',
        target: { targetKey: FsTargetKey(key), displayPath: key },
        size: this.backing.get(key)?.length ?? 0,
        version: FsVersion('v1'),
      })
    }
    return entries
  }

  override async writeText(target: FsTarget, content: string, _expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    const before = this.backing.get(String(target.targetKey)) ?? null
    this.backing.set(String(target.targetKey), content)
    return { operation: before !== null ? 'update' : 'create', version: FsVersion('v2'), before, after: content }
  }

  override async editText(target: FsTarget, edit: FsEditRequest): Promise<FsEditOutcome> {
    const content = this.backing.get(String(target.targetKey)) ?? ''
    const after = content.split(edit.oldString).join(edit.newString)
    this.backing.set(String(target.targetKey), after)
    return { version: FsVersion('v3'), before: content, after }
  }

  /** Seed one file (path → content) into the backing map. */
  seed(path: string, content: string): void {
    this.backing.set(path, content)
  }
}
