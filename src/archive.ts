import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

export const LIMITS = {
  compressedBytes: 10 * 1024 * 1024,
  uncompressedBytes: 25 * 1024 * 1024,
  files: 1000,
};

export class ArchiveError extends Error {}

/** One skill folder found in an archive: its name and files (relative paths). */
export type ArchiveSkill = {
  name: string;
  files: Map<string, Uint8Array>;
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Reject any entry name that could escape the target folder or break on some OS. */
function checkEntryName(name: string): string[] {
  if (name.includes('\0'))
    throw new ArchiveError(`Invalid entry name: ${JSON.stringify(name)}`);
  if (name.includes('\\'))
    throw new ArchiveError(`Backslash in entry name: ${name}`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new ArchiveError(`Absolute path in archive: ${name}`);
  }
  const parts = name.split('/').filter((p) => p !== '');
  if (parts.length === 0) throw new ArchiveError('Empty entry name in archive');
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new ArchiveError(`Path traversal in archive: ${name}`);
    }
    if (
      WINDOWS_RESERVED.test(part) ||
      /[. ]$/.test(part) ||
      /[<>:"|?*]/.test(part)
    ) {
      throw new ArchiveError(`Entry name not valid on every OS: ${name}`);
    }
  }
  return parts;
}

/**
 * Read the `name` field from a SKILL.md frontmatter (no YAML library needed:
 * the spec requires a plain lowercase slug).
 */
export function readSkillName(skillMd: Uint8Array): string | null {
  const text = new TextDecoder().decode(skillMd).replace(/^﻿/, '');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm?.[1]) return null;
  const line = fm[1].match(/^name:\s*["']?([a-z0-9-]+)["']?\s*$/m);
  return line?.[1] ?? null;
}

/**
 * Unpack a skill archive in memory and return its skill folders. Accepted
 * layouts: files at the root (a single skill named `fallbackName`), one
 * `<name>/` folder, or several `<name>/` folders (a pack). Every skill must
 * have a SKILL.md whose `name` matches its folder. Nothing touches disk here.
 */
export function readSkillArchive(
  zip: Uint8Array,
  fallbackName: string
): ArchiveSkill[] {
  if (zip.byteLength > LIMITS.compressedBytes) {
    throw new ArchiveError('Archive is larger than 10 MB');
  }

  let total = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (file) => {
        count += 1;
        total += file.originalSize;
        if (count > LIMITS.files)
          throw new ArchiveError('Archive has too many files');
        if (total > LIMITS.uncompressedBytes) {
          throw new ArchiveError('Archive unpacks to more than 25 MB');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(
      `Not a valid ZIP archive: ${(error as Error).message}`
    );
  }

  // Normalize names, skip directory entries, catch collisions
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  for (const [rawName, data] of Object.entries(entries)) {
    if (rawName.endsWith('/')) {
      checkEntryName(rawName);
      continue;
    }
    if (rawName.startsWith('__MACOSX/') || rawName.endsWith('.DS_Store'))
      continue;
    const parts = checkEntryName(rawName);
    const path = parts.join('/');
    const key = path.toLowerCase();
    if (seen.has(key))
      throw new ArchiveError(`Duplicate entry (case-insensitive): ${path}`);
    seen.add(key);
    files.set(path, data);
  }
  for (const path of files.keys()) {
    const asDir = `${path.toLowerCase()}/`;
    for (const other of seen) {
      if (other.startsWith(asDir)) {
        throw new ArchiveError(`Entry is both a file and a folder: ${path}`);
      }
    }
  }
  if (files.size === 0) throw new ArchiveError('Archive is empty');

  // Flat layout: SKILL.md at the root
  if (files.has('SKILL.md')) {
    return [toSkill(fallbackName, files)];
  }

  // Folder layout: group by top-level folder
  const groups = new Map<string, Map<string, Uint8Array>>();
  for (const [path, data] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      throw new ArchiveError(`Unexpected file at the archive root: ${path}`);
    }
    const folder = path.slice(0, slash);
    const inner = path.slice(slash + 1);
    if (!groups.has(folder)) groups.set(folder, new Map());
    groups.get(folder)?.set(inner, data);
  }
  return [...groups].map(([folder, inner]) => toSkill(folder, inner));
}

function toSkill(name: string, files: Map<string, Uint8Array>): ArchiveSkill {
  const skillMd = files.get('SKILL.md');
  if (!skillMd) throw new ArchiveError(`No SKILL.md in "${name}"`);
  const declared = readSkillName(skillMd);
  if (declared !== name) {
    throw new ArchiveError(
      `SKILL.md in "${name}" declares name "${declared ?? '(none)'}"; they must match`
    );
  }
  return { name, files };
}
