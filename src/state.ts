import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stateFile } from './paths.js';

export type InstalledLink = {
  agent: string;
  path: string;
  /** symlink to the main copy, a copy of it, or the agent reads the main copy directly */
  mode: 'symlink' | 'copy' | 'shared';
};

export type InstalledSkill = {
  slug: string;
  name: string;
  version: string | null;
  sha256: string;
  /** Folder holding the skill: the main copy, or the --target folder */
  path: string;
  project: string | null;
  target: boolean;
  links: InstalledLink[];
  installedAt: string;
};

type State = { version: 1; skills: InstalledSkill[] };

export function readState(): InstalledSkill[] {
  try {
    const state = JSON.parse(readFileSync(stateFile(), 'utf8')) as State;
    return Array.isArray(state.skills) ? state.skills : [];
  } catch {
    return [];
  }
}

export function writeState(skills: InstalledSkill[]): void {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ version: 1, skills } satisfies State, null, 2)
  );
  renameSync(tmp, file);
}

/** Replace the entries at the same paths, keep the rest. */
export function upsertState(entries: InstalledSkill[]): void {
  const paths = new Set(entries.map((e) => e.path));
  writeState([...readState().filter((s) => !paths.has(s.path)), ...entries]);
}

export function removeFromState(paths: string[]): void {
  const drop = new Set(paths);
  writeState(readState().filter((s) => !drop.has(s.path)));
}
