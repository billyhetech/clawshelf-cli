import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENTS, findAgent } from '../src/agents.js';
import {
  InstallError,
  type InstallPlan,
  install,
  remove,
  update,
} from '../src/install.js';
import { backupsDir } from '../src/paths.js';
import { readState } from '../src/state.js';
import { fakeApi, skillMd, zip } from './helpers.js';

const agent = (id: string) => {
  const a = findAgent(id);
  if (!a) throw new Error(id);
  return a;
};
const plan = (over: Partial<InstallPlan> = {}): InstallPlan => ({
  project: null,
  target: null,
  agents: [agent('claude-code'), agent('codex'), agent('cursor')],
  copy: false,
  force: false,
  ...over,
});
const lines: string[] = [];
const print = (l: string) => lines.push(l);
beforeEach(() => {
  lines.length = 0;
});

const demoZip = (body = 'v1') =>
  zip({
    'demo/SKILL.md': skillMd('demo', body),
    'demo/references/r.md': 'ref',
  });

describe('install', () => {
  it('puts the main copy in ~/.agents/skills and links other agents to it', async () => {
    const { api } = fakeApi([
      { slug: 'cs-demo', name: 'demo', zip: demoZip() },
    ]);
    const [entry] = await install(['cs-demo'], plan(), { api, print });
    const home = homedir();
    const main = join(home, '.agents', 'skills', 'demo');

    expect(entry?.path).toBe(main);
    expect(readFileSync(join(main, 'SKILL.md'), 'utf8')).toContain('v1');
    expect(existsSync(join(main, 'references', 'r.md'))).toBe(true);

    // Claude Code: relative symlink to the main copy
    const claude = join(home, '.claude', 'skills', 'demo');
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claude)).not.toMatch(/^\//);
    expect(readFileSync(join(claude, 'SKILL.md'), 'utf8')).toContain('v1');
    // Codex reads the shared folder directly; Cursor gets its own link
    expect(entry?.links).toEqual([
      { agent: 'claude-code', path: claude, mode: 'symlink' },
      {
        agent: 'codex',
        path: join(home, '.agents', 'skills', 'demo'),
        mode: 'shared',
      },
      {
        agent: 'cursor',
        path: join(home, '.cursor', 'skills', 'demo'),
        mode: 'symlink',
      },
    ]);
    expect(readState()).toHaveLength(1);
    // Staging is cleaned up
    expect(readdirSync(join(home, '.clawshelf', 'cli', 'staging'))).toEqual([]);
  });

  it('respects CLAUDE_CONFIG_DIR', async () => {
    const custom = join(homedir(), 'custom-claude');
    process.env.CLAUDE_CONFIG_DIR = custom;
    const { api } = fakeApi([
      { slug: 'cs-demo', name: 'demo', zip: demoZip() },
    ]);
    await install(['cs-demo'], plan({ agents: [agent('claude-code')] }), {
      api,
      print,
    });
    expect(lstatSync(join(custom, 'skills', 'demo')).isSymbolicLink()).toBe(
      true
    );
    expect(existsSync(join(homedir(), '.claude'))).toBe(false);
  });

  it('copies instead of linking with --copy', async () => {
    const { api } = fakeApi([
      { slug: 'cs-demo', name: 'demo', zip: demoZip() },
    ]);
    const [entry] = await install(['cs-demo'], plan({ copy: true }), {
      api,
      print,
    });
    const claude = join(homedir(), '.claude', 'skills', 'demo');
    expect(lstatSync(claude).isDirectory()).toBe(true);
    expect(entry?.links[0]?.mode).toBe('copy');
  });

  it('installs straight into --target with no links', async () => {
    const target = join(homedir(), 'my-agent', 'skills');
    const { api } = fakeApi([
      { slug: 'cs-demo', name: 'demo', zip: demoZip() },
    ]);
    const [entry] = await install(['cs-demo'], plan({ target, agents: [] }), {
      api,
      print,
    });
    expect(entry?.path).toBe(join(target, 'demo'));
    expect(entry?.links).toEqual([]);
    expect(existsSync(join(homedir(), '.agents'))).toBe(false);
  });

  it('installs into the project with --project', async () => {
    const project = join(homedir(), 'proj');
    mkdirSync(project);
    const { api } = fakeApi([
      { slug: 'cs-demo', name: 'demo', zip: demoZip() },
    ]);
    const [entry] = await install(['cs-demo'], plan({ project }), {
      api,
      print,
    });
    expect(entry?.path).toBe(join(project, '.agents', 'skills', 'demo'));
    expect(
      lstatSync(join(project, '.claude', 'skills', 'demo')).isSymbolicLink()
    ).toBe(true);
    // Cursor's project folder is the shared one
    expect(entry?.links.find((l) => l.agent === 'cursor')?.mode).toBe('shared');
  });

  it('installs every skill in a pack', async () => {
    const { api } = fakeApi([
      {
        slug: 'cs-pack',
        name: 'my-pack',
        zip: zip({ 'a/SKILL.md': skillMd('a'), 'b/SKILL.md': skillMd('b') }),
      },
    ]);
    const entries = await install(['cs-pack'], plan(), { api, print });
    expect(entries.map((e) => e.name).sort()).toEqual(['a', 'b']);
    expect(readState().every((s) => s.slug === 'cs-pack')).toBe(true);
  });

  it('refuses to replace a folder it did not install, unless --force (backed up)', async () => {
    const main = join(homedir(), '.agents', 'skills', 'demo');
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, 'SKILL.md'), 'mine');
    const { api } = fakeApi([
      { slug: 'cs-demo', name: 'demo', zip: demoZip() },
    ]);

    await expect(
      install(['cs-demo'], plan(), { api, print })
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(readFileSync(join(main, 'SKILL.md'), 'utf8')).toBe('mine');

    await install(['cs-demo'], plan({ force: true }), { api, print });
    expect(readFileSync(join(main, 'SKILL.md'), 'utf8')).toContain('v1');
    const backups = readdirSync(backupsDir());
    expect(backups).toHaveLength(1);
    expect(
      readFileSync(join(backupsDir(), backups[0] as string, 'SKILL.md'), 'utf8')
    ).toBe('mine');
  });

  it('skips an agent folder it did not create', async () => {
    const claude = join(homedir(), '.claude', 'skills', 'demo');
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, 'SKILL.md'), 'mine');
    const { api } = fakeApi([
      { slug: 'cs-demo', name: 'demo', zip: demoZip() },
    ]);
    const [entry] = await install(['cs-demo'], plan(), { api, print });
    expect(readFileSync(join(claude, 'SKILL.md'), 'utf8')).toBe('mine');
    expect(entry?.links.some((l) => l.agent === 'claude-code')).toBe(false);
    expect(lines.some((l) => l.includes('Skipped Claude Code'))).toBe(true);
  });

  it('rejects a corrupted download', async () => {
    const { api } = fakeApi([
      {
        slug: 'cs-demo',
        name: 'demo',
        zip: demoZip(),
        headerSha: 'f'.repeat(64),
      },
    ]);
    await expect(install(['cs-demo'], plan(), { api, print })).rejects.toThrow(
      /Checksum mismatch/
    );
    expect(existsSync(join(homedir(), '.agents', 'skills', 'demo'))).toBe(
      false
    );
  });

  it('maps access problems to exit codes before downloading', async () => {
    const { api, calls } = fakeApi([
      {
        slug: 'cs-paid',
        name: 'paid',
        zip: demoZip(),
        access: 'login_required',
      },
      {
        slug: 'cs-pro',
        name: 'pro',
        zip: demoZip(),
        access: 'membership_required',
      },
      {
        slug: 'cs-buy',
        name: 'buy',
        zip: demoZip(),
        access: 'purchase_required',
      },
    ]);
    const code = async (slug: string) =>
      install([slug], plan(), { api, print }).catch(
        (e: InstallError) => e.exitCode
      );
    expect(await code('cs-paid')).toBe(3);
    expect(await code('cs-pro')).toBe(2);
    expect(await code('cs-buy')).toBe(2);
    expect(calls.some((c) => c.includes('/download'))).toBe(false);
  });

  it('explains unknown, delisted and external skills', async () => {
    const { api } = fakeApi([
      { slug: 'cs-gone', name: 'gone', status: 'delisted' },
      { slug: 'cs-ext', name: 'ext', external: true },
    ]);
    await expect(
      install(['nope'], plan(), { api, print })
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      install(['cs-gone'], plan(), { api, print })
    ).rejects.toMatchObject({
      code: 'delisted',
    });
    await expect(install(['cs-ext'], plan(), { api, print })).rejects.toThrow(
      /npx skills add acme\/x --skill ext/
    );
  });
});

describe('update', () => {
  it('reinstalls changed skills in place and keeps their links', async () => {
    const catalog = [
      { slug: 'cs-demo', name: 'demo', version: '1.0.0', zip: demoZip('v1') },
    ];
    const first = fakeApi(catalog);
    await install(['cs-demo'], plan(), { api: first.api, print });

    const unchanged = await update([], AGENTS, {
      api: fakeApi(catalog).api,
      print,
    });
    expect(unchanged.current).toEqual(['cs-demo']);
    expect(unchanged.updated).toEqual([]);

    const next = fakeApi([
      { slug: 'cs-demo', name: 'demo', version: '1.1.0', zip: demoZip('v2') },
    ]);
    const result = await update([], AGENTS, { api: next.api, print });
    expect(result.updated.map((e) => e.version)).toEqual(['1.1.0']);
    const claude = join(homedir(), '.claude', 'skills', 'demo');
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(claude, 'SKILL.md'), 'utf8')).toContain('v2');
    expect(readState()).toHaveLength(1);
    // Update doesn't count as replacing a user's folder: no "backed up" notice
    expect(lines.some((l) => l.includes('Backed up the existing demo'))).toBe(
      false
    );
  });

  it('reports skills that now need a purchase without stopping the others', async () => {
    const { api } = fakeApi([
      { slug: 'cs-a', name: 'a', zip: zip({ 'a/SKILL.md': skillMd('a') }) },
      { slug: 'cs-b', name: 'b', zip: zip({ 'b/SKILL.md': skillMd('b') }) },
    ]);
    await install(['cs-a', 'cs-b'], plan(), { api, print });
    const next = fakeApi([
      {
        slug: 'cs-a',
        name: 'a',
        version: '2.0.0',
        zip: zip({ 'a/SKILL.md': skillMd('a', 'v2') }),
        access: 'purchase_required',
      },
      {
        slug: 'cs-b',
        name: 'b',
        version: '2.0.0',
        zip: zip({ 'b/SKILL.md': skillMd('b', 'v2') }),
      },
    ]);
    const result = await update([], AGENTS, { api: next.api, print });
    expect(result.updated.map((e) => e.name)).toEqual(['b']);
    expect(result.failed.map((f) => [f.slug, f.error.exitCode])).toEqual([
      ['cs-a', 2],
    ]);
  });
});

describe('remove', () => {
  it('deletes the main copy and its links, and only those', async () => {
    const { api } = fakeApi([
      { slug: 'cs-demo', name: 'demo', zip: demoZip() },
    ]);
    await install(['cs-demo'], plan(), { api, print });
    const other = join(homedir(), '.claude', 'skills', 'other');
    mkdirSync(other, { recursive: true });

    remove(['demo']);
    expect(existsSync(join(homedir(), '.agents', 'skills', 'demo'))).toBe(
      false
    );
    expect(existsSync(join(homedir(), '.claude', 'skills', 'demo'))).toBe(
      false
    );
    expect(existsSync(other)).toBe(true);
    expect(readState()).toEqual([]);
  });

  it('errors on something it did not install', () => {
    expect(() => remove(['nope'])).toThrow(InstallError);
  });
});
