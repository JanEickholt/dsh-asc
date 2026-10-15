import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface PackageManifest {
  readonly name: string
  readonly peerDependencies: Readonly<Record<string, string>>
}

const pkg = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
) as PackageManifest

/** Row names from the shipped patch; comment lines are not rows. */
function rowNames(): string[] {
  const names: string[] = []
  for (const line of readFileSync(join(root, 'cordis.patch.yml'), 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue
    const match = /^\s*name:\s*['"]?([^\s'"]+)['"]?\s*$/.exec(line)
    if (match) names.push(match[1]!)
  }
  return names
}

describe('shipped bundle patch resolves in a real profile', () => {
  /**
   * The loader imports each row's `name` as a module specifier from the
   * profile root (issue #5): a bare alias like `dsh-asc` is not installed
   * there, the row never starts, and the UI keeps asking for a restart.
   * Only specifiers a profile install can actually resolve are allowed.
   */
  it('every row name is this package, a subpath of it, or a declared peer', () => {
    const names = rowNames()
    expect(names.length).toBeGreaterThan(0)
    const resolvable = (name: string): boolean =>
      name === pkg.name
      || name.startsWith(`${pkg.name}/`)
      || (name.startsWith('@deepseek-ai/') && name in pkg.peerDependencies)
    expect(names.filter(name => !resolvable(name))).toEqual([])
  })

  it('mounts the compaction backend row', () => {
    expect(rowNames()).toContain(pkg.name)
  })
})
