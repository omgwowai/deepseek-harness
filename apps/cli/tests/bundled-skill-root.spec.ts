import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveBundledSkillRoot } from '../src/profile-boot.ts'

const SHIPPED_SKILLS = fileURLToPath(new URL('../config/skills/', import.meta.url))

describe('resolveBundledSkillRoot', () => {
  it('installs the shipped root when the environment names none', () => {
    const resolved = resolveBundledSkillRoot(undefined)
    expect(resolved).toBe(SHIPPED_SKILLS)
    expect(existsSync(join(resolved ?? '', 'j-space/SKILL.md'))).toBe(true)
  })

  it('defers to any inherited value, including one that mounts no root', () => {
    // The empty string is a deployment saying "no bundled skills"; treating it
    // as unset would remount the shipped root it just cleared.
    expect(resolveBundledSkillRoot('/opt/skills')).toBeUndefined()
    expect(resolveBundledSkillRoot('')).toBeUndefined()
  })
})

describe('shipped skill root', () => {
  it('holds only skill directories, so no loose file is parsed as a skill', () => {
    // A root is scanned entry by entry: a directory contributes its `SKILL.md`,
    // but a stray `.md` file at the top level is itself read as a skill and
    // logged as ignored on every boot. Documentation belongs in the app README.
    expect(existsSync(join(SHIPPED_SKILLS, 'README.md'))).toBe(false)
  })

  it('keeps the upstream Apache-2.0 license beside the vendored suite', () => {
    const license = readFileSync(join(SHIPPED_SKILLS, 'j-space/LICENSE'), 'utf8')
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0')
  })

  it('declares the frontmatter the local provider requires to publish a skill', () => {
    const skill = readFileSync(join(SHIPPED_SKILLS, 'j-space/SKILL.md'), 'utf8')
    expect(skill.startsWith('---\n')).toBe(true)
    const frontmatter = skill.slice(4, skill.indexOf('\n---', 4))
    expect(frontmatter).toMatch(/^name: j-space$/m)
    expect(frontmatter).toMatch(/^description: /m)
  })
})
