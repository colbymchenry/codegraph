/**
 * The root agent guide indexes the repo skills under `.claude/skills/`, and it
 * is the only way Codex and other harnesses that don't load Claude skills learn
 * those procedures exist. A skill added without an index line (or an index line
 * for a skill that was renamed or removed) fails silently: every agent keeps
 * following a shorter guide and never reads the missing procedure. This test
 * pins both directions of that index and the frontmatter each skill needs to be
 * loaded at all.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const AGENTS = path.resolve('AGENTS.md');
const SKILLS_DIR = path.resolve('.claude/skills');

function skillsSection(): string {
  const text = fs.readFileSync(AGENTS, 'utf-8').replace(/\r\n/g, '\n');
  const start = text.indexOf('\n## Skills\n');
  expect(start, 'AGENTS.md has a ## Skills section').toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n## ', start + 1);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

function listedSkills(): string[] {
  return [...skillsSection().matchAll(/^- `([a-z0-9][a-z0-9-]*)`/gm)].map((m) => m[1]);
}

function frontmatter(skill: string): { name?: string; description?: string } {
  const text = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf-8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  expect(match, `${skill}/SKILL.md starts with YAML frontmatter`).not.toBeNull();
  const fields: { name?: string; description?: string } = {};
  for (const line of match![1].split(/\r?\n/)) {
    const field = /^(name|description):\s*(.+)$/.exec(line);
    if (field) fields[field[1] as 'name' | 'description'] = field[2].trim();
  }
  return fields;
}

describe('AGENTS.md skills index', () => {
  it('lists every skill directory under .claude/skills/', () => {
    const onDisk = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(listedSkills().sort()).toEqual(onDisk);
  });

  it('names a SKILL.md that exists for every listed skill', () => {
    for (const skill of listedSkills()) {
      expect(fs.existsSync(path.join(SKILLS_DIR, skill, 'SKILL.md')), `${skill}/SKILL.md`).toBe(true);
    }
  });

  it('gives every skill a name matching its directory and a non-empty description', () => {
    for (const skill of listedSkills()) {
      const { name, description } = frontmatter(skill);
      expect(name, `${skill}/SKILL.md name`).toBe(skill);
      expect(description, `${skill}/SKILL.md description`).toBeTruthy();
    }
  });
});
