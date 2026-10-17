import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ArchiveError,
  LIMITS,
  readSkillArchive,
  readSkillName,
} from '../src/archive.js';
import { skillMd, zip } from './helpers.js';

const enc = new TextEncoder();

describe('readSkillName', () => {
  it('reads plain and quoted names', () => {
    expect(readSkillName(enc.encode(skillMd('basic-memory')))).toBe(
      'basic-memory'
    );
    expect(
      readSkillName(
        enc.encode('---\nname: "twitter-engine"\ndescription: x\n---\n')
      )
    ).toBe('twitter-engine');
    expect(readSkillName(enc.encode('\uFEFF---\r\nname: a-b\r\n---\r\n'))).toBe(
      'a-b'
    );
  });

  it('returns null without frontmatter or name', () => {
    expect(readSkillName(enc.encode('# no frontmatter'))).toBeNull();
    expect(readSkillName(enc.encode('---\ndescription: x\n---\n'))).toBeNull();
  });
});

describe('readSkillArchive: accepted layouts', () => {
  it('files at the root become one skill named by the server', () => {
    const skills = readSkillArchive(
      zip({ 'SKILL.md': skillMd('demo'), 'references/a.md': 'A' }),
      'demo'
    );
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('demo');
    expect([...(skills[0]?.files.keys() ?? [])].sort()).toEqual([
      'SKILL.md',
      'references/a.md',
    ]);
  });

  it('a single <name>/ folder', () => {
    const skills = readSkillArchive(
      zip({ 'demo/SKILL.md': skillMd('demo'), 'demo/scripts/x.sh': 'echo' }),
      'demo'
    );
    expect(skills.map((s) => s.name)).toEqual(['demo']);
    expect(skills[0]?.files.has('scripts/x.sh')).toBe(true);
  });

  it('several folders (a pack)', () => {
    const skills = readSkillArchive(
      zip({ 'a/SKILL.md': skillMd('a'), 'b/SKILL.md': skillMd('b') }),
      'my-pack'
    );
    expect(skills.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('ignores macOS metadata and directory entries', () => {
    const skills = readSkillArchive(
      zipSync({
        'demo/': new Uint8Array(),
        'demo/SKILL.md': enc.encode(skillMd('demo')),
        '__MACOSX/demo/._SKILL.md': enc.encode('junk'),
        'demo/.DS_Store': enc.encode('junk'),
      }),
      'demo'
    );
    expect([...(skills[0]?.files.keys() ?? [])]).toEqual(['SKILL.md']);
  });
});

describe('readSkillArchive: rejected archives', () => {
  const bad: [string, Record<string, string>][] = [
    [
      'path traversal',
      { 'demo/SKILL.md': skillMd('demo'), 'demo/../../evil': 'x' },
    ],
    ['absolute path', { '/etc/evil': 'x', 'SKILL.md': skillMd('demo') }],
    ['drive letter', { 'C:/evil': 'x', 'SKILL.md': skillMd('demo') }],
    ['backslash', { 'demo\\..\\evil': 'x', 'SKILL.md': skillMd('demo') }],
    [
      'Windows device name',
      { 'demo/SKILL.md': skillMd('demo'), 'demo/CON.txt': 'x' },
    ],
    ['trailing dot', { 'demo/SKILL.md': skillMd('demo'), 'demo/evil.': 'x' }],
    [
      'case-insensitive duplicate',
      { 'demo/SKILL.md': skillMd('demo'), 'demo/a.md': 'x', 'demo/A.md': 'y' },
    ],
    [
      'file and folder with the same name',
      {
        'demo/SKILL.md': skillMd('demo'),
        'demo/x': 'file',
        'demo/x/y': 'nested',
      },
    ],
    ['no SKILL.md', { 'demo/README.md': 'x' }],
    ['name mismatch', { 'demo/SKILL.md': skillMd('other') }],
    [
      'stray root file next to folders',
      { 'demo/SKILL.md': skillMd('demo'), 'x.txt': 'x' },
    ],
  ];

  for (const [label, files] of bad) {
    it(label, () => {
      expect(() => readSkillArchive(zip(files), 'demo')).toThrow(ArchiveError);
    });
  }

  it('not a ZIP', () => {
    expect(() => readSkillArchive(enc.encode('hello'), 'demo')).toThrow(
      ArchiveError
    );
  });

  it('empty archive', () => {
    expect(() => readSkillArchive(zipSync({}), 'demo')).toThrow(ArchiveError);
  });

  it('too large', () => {
    expect(() =>
      readSkillArchive(new Uint8Array(LIMITS.compressedBytes + 1), 'demo')
    ).toThrow(/larger than 10 MB/);
  });

  it('too many files', () => {
    const files: Record<string, string> = { 'demo/SKILL.md': skillMd('demo') };
    for (let i = 0; i < LIMITS.files; i++) files[`demo/f${i}.txt`] = 'x';
    expect(() => readSkillArchive(zip(files), 'demo')).toThrow(
      /too many files/
    );
  });

  it('unpacks too large', () => {
    const big = new Uint8Array(LIMITS.uncompressedBytes + 1); // zeros compress well
    expect(() =>
      readSkillArchive(
        zipSync({
          'demo/SKILL.md': enc.encode(skillMd('demo')),
          'demo/big.bin': big,
        }),
        'demo'
      )
    ).toThrow(/more than 25 MB/);
  });
});
