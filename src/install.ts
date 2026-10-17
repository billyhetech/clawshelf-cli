import { randomUUID } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { type Agent, agentSkillsDir, sharedSkillsDir } from './agents.js';
import { type Api, ApiError, type RemoteSkill } from './api.js';
import { type ArchiveSkill, readSkillArchive, sha256 } from './archive.js';
import { backupsDir, stagingDir } from './paths.js';
import {
  type InstalledLink,
  type InstalledSkill,
  readState,
  removeFromState,
  upsertState,
} from './state.js';

/** Where and how to install, decided from the flags (and prompt) up front. */
export type InstallPlan = {
  /** Project root for --project, null for a global install */
  project: string | null;
  /** --target: install straight into this parent folder, no links */
  target: string | null;
  agents: Agent[];
  copy: boolean;
  force: boolean;
};

export type InstallContext = {
  api: Api;
  print: (line: string) => void;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

/** Stops the install with a message for the user and an exit code. */
export class InstallError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code?: string,
    readonly url?: string
  ) {
    super(message);
  }
}

// ── File system helpers ──

function existsLink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** rename, falling back to copy + delete across volumes. */
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function backup(path: string, name: string): string {
  const dest = join(
    backupsDir(),
    `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  move(path, dest);
  return dest;
}

function writeSkillFiles(dir: string, skill: ArchiveSkill): void {
  for (const [file, data] of skill.files) {
    const path = join(dir, ...file.split('/'));
    // Belt and braces: archive.ts already rejects these
    if (!resolve(path).startsWith(resolve(dir))) {
      throw new InstallError(
        `Refusing to write outside the skill folder: ${file}`,
        1
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
}

function linkInto(
  mainPath: string,
  linkPath: string,
  copy: boolean
): 'symlink' | 'copy' {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (!copy) {
    try {
      if (process.platform === 'win32') {
        symlinkSync(mainPath, linkPath, 'junction');
      } else {
        symlinkSync(relative(dirname(linkPath), mainPath), linkPath, 'dir');
      }
      return 'symlink';
    } catch {
      // No symlink permission (Windows without developer mode): copy instead
    }
  }
  cpSync(mainPath, linkPath, { recursive: true });
  return 'copy';
}

// ── Placing one skill ──

function placeSkill(
  skill: ArchiveSkill,
  remote: Pick<RemoteSkill, 'slug' | 'version'>,
  archiveSha: string,
  plan: InstallPlan,
  ctx: InstallContext
): InstalledSkill {
  const home = ctx.home ?? homedir();
  const env = ctx.env ?? process.env;
  const scope = { project: plan.project };
  const root = plan.target ?? sharedSkillsDir(scope, home);
  const mainPath = join(root, skill.name);
  const state = readState();
  const previous = state.find((s) => s.path === mainPath);

  if (existsLink(mainPath) && !previous && !plan.force) {
    throw new InstallError(
      `${mainPath} already exists and wasn't installed by clawshelf. Re-run with --force to replace it (the old folder is backed up).`,
      1,
      'conflict'
    );
  }

  // 1. Write to staging, then move into place in one step
  const staging = join(stagingDir(), randomUUID(), skill.name);
  try {
    writeSkillFiles(staging, skill);
    if (existsLink(mainPath)) {
      const saved = backup(mainPath, skill.name);
      if (!previous)
        ctx.print(`  Backed up the existing ${skill.name} to ${saved}`);
    }
    move(staging, mainPath);
  } finally {
    rmSync(dirname(staging), { recursive: true, force: true });
  }

  // 2. Point every chosen agent at it
  const links: InstalledLink[] = [];
  if (!plan.target) {
    const done = new Set<string>([resolve(root)]);
    for (const agent of plan.agents) {
      const dir = agentSkillsDir(agent, scope, home, env);
      if (done.has(resolve(dir))) {
        links.push({
          agent: agent.id,
          path: join(dir, skill.name),
          mode: 'shared',
        });
        continue;
      }
      done.add(resolve(dir));
      const linkPath = join(dir, skill.name);
      const ours = previous?.links.some((l) => l.path === linkPath) ?? false;
      if (existsLink(linkPath)) {
        const pointsHere =
          isSymlink(linkPath) &&
          resolve(dirname(linkPath), readlinkSync(linkPath)) ===
            resolve(mainPath);
        if (pointsHere || ours) {
          rmSync(linkPath, { recursive: true, force: true });
        } else if (plan.force) {
          backup(linkPath, skill.name);
        } else {
          ctx.print(
            `  Skipped ${agent.name}: ${linkPath} already exists and wasn't installed by clawshelf (use --force to replace it).`
          );
          continue;
        }
      }
      links.push({
        agent: agent.id,
        path: linkPath,
        mode: linkInto(mainPath, linkPath, plan.copy),
      });
    }
  }

  return {
    slug: remote.slug,
    name: skill.name,
    version: remote.version,
    sha256: archiveSha,
    path: mainPath,
    project: plan.project,
    target: plan.target !== null,
    links,
    installedAt: new Date().toISOString(),
  };
}

// ── Commands ──

function accessError(remote: RemoteSkill): InstallError {
  switch (remote.access) {
    case 'login_required':
      return new InstallError(
        `${remote.title} is a paid skill. Run \`clawshelf login\` first.`,
        3,
        'login_required',
        remote.pageUrl
      );
    case 'membership_required':
      return new InstallError(
        `${remote.title} is included with ClawShelf Pro and Lifetime: ${remote.unlockUrl}`,
        2,
        'membership_required',
        remote.unlockUrl
      );
    default:
      return new InstallError(
        `Buy ${remote.title} or join Pro / Lifetime to install it: ${remote.unlockUrl}`,
        2,
        'purchase_required',
        remote.unlockUrl
      );
  }
}

function toInstallError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const code =
    error.code === 'login_required' ? 3 : error.status === 402 ? 2 : 1;
  return new InstallError(
    error.url ? `${error.message} ${error.url}` : error.message,
    code,
    error.code,
    error.url
  );
}

/** Download, verify and place one remote skill (or pack). */
async function installRemote(
  remote: RemoteSkill,
  plan: InstallPlan,
  ctx: InstallContext
): Promise<InstalledSkill[]> {
  if (remote.status === 'delisted') {
    throw new InstallError(
      `${remote.title} was removed from ClawShelf.`,
      1,
      'delisted'
    );
  }
  if (remote.external) {
    throw new InstallError(
      `${remote.title} installs from its author's repository${remote.installCommand ? `:\n  ${remote.installCommand}` : '.'}`,
      1,
      'external'
    );
  }
  if (remote.access !== 'granted') throw accessError(remote);

  let download: Awaited<ReturnType<Api['download']>>;
  try {
    download = await ctx.api.download(remote.slug);
  } catch (error) {
    throw toInstallError(error);
  }
  const actual = sha256(download.bytes);
  if (actual !== download.sha256) {
    throw new InstallError(
      'Checksum mismatch: the download was corrupted. Try again.',
      1
    );
  }
  const skills = readSkillArchive(download.bytes, download.name);
  const entries = skills.map((skill) =>
    placeSkill(
      skill,
      { slug: remote.slug, version: download.version ?? remote.version },
      actual,
      plan,
      ctx
    )
  );
  upsertState(entries);
  return entries;
}

async function lookupAll(
  slugs: string[],
  ctx: InstallContext
): Promise<RemoteSkill[]> {
  let result: Awaited<ReturnType<Api['lookup']>>;
  try {
    result = await ctx.api.lookup(slugs);
  } catch (error) {
    throw toInstallError(error);
  }
  if (result.notFound.length > 0) {
    throw new InstallError(
      `No skill named ${result.notFound.map((s) => `"${s}"`).join(', ')} on ClawShelf. Browse https://clawshelf.com/skills`,
      1,
      'not_found'
    );
  }
  // Keep the order the user asked for
  return slugs
    .map((slug) =>
      result.skills.find((s) => s.slug === slug || s.name === slug)
    )
    .filter((s): s is RemoteSkill => Boolean(s));
}

export async function install(
  slugs: string[],
  plan: InstallPlan,
  ctx: InstallContext
): Promise<InstalledSkill[]> {
  const remotes = await lookupAll(slugs, ctx);
  const installed: InstalledSkill[] = [];
  for (const remote of remotes) {
    installed.push(...(await installRemote(remote, plan, ctx)));
  }
  return installed;
}

/** Plan that reproduces how an installed skill was set up. */
function planFor(entries: InstalledSkill[], agents: Agent[]): InstallPlan {
  const first = entries[0] as InstalledSkill;
  return {
    project: first.project,
    target: first.target ? dirname(first.path) : null,
    agents: agents.filter((a) => first.links.some((l) => l.agent === a.id)),
    copy:
      first.links.length > 0 && first.links.every((l) => l.mode !== 'symlink'),
    force: false,
  };
}

export type UpdateResult = {
  updated: InstalledSkill[];
  current: string[];
  failed: { slug: string; error: InstallError }[];
};

export async function update(
  slugs: string[],
  allAgents: Agent[],
  ctx: InstallContext
): Promise<UpdateResult> {
  const state = readState();
  const wanted = slugs.length
    ? state.filter((s) => slugs.includes(s.slug) || slugs.includes(s.name))
    : state;
  if (slugs.length && wanted.length === 0) {
    throw new InstallError(
      `None of ${slugs.join(', ')} is installed by clawshelf.`,
      1
    );
  }
  const bySlugAndPlace = new Map<string, InstalledSkill[]>();
  for (const entry of wanted) {
    const key = `${entry.slug}\n${dirname(entry.path)}`;
    bySlugAndPlace.set(key, [...(bySlugAndPlace.get(key) ?? []), entry]);
  }

  const remotes = wanted.length
    ? await lookupAll([...new Set(wanted.map((s) => s.slug))], ctx)
    : [];
  const result: UpdateResult = { updated: [], current: [], failed: [] };

  for (const entries of bySlugAndPlace.values()) {
    const first = entries[0] as InstalledSkill;
    const remote = remotes.find((r) => r.slug === first.slug);
    if (!remote) continue;
    const changed =
      (remote.archiveSha256 !== null &&
        remote.archiveSha256 !== first.sha256) ||
      (remote.version !== null && remote.version !== first.version);
    if (!changed) {
      result.current.push(first.slug);
      continue;
    }
    try {
      result.updated.push(
        ...(await installRemote(remote, planFor(entries, allAgents), ctx))
      );
    } catch (error) {
      if (!(error instanceof InstallError)) throw error;
      result.failed.push({ slug: first.slug, error });
    }
  }
  return result;
}

export function remove(names: string[]): InstalledSkill[] {
  const state = readState();
  const targets = state.filter(
    (s) => names.includes(s.slug) || names.includes(s.name)
  );
  if (targets.length === 0) {
    throw new InstallError(
      `None of ${names.join(', ')} is installed by clawshelf.`,
      1
    );
  }
  for (const entry of targets) {
    for (const link of entry.links) {
      if (link.mode === 'shared') continue;
      if (link.mode === 'symlink' && !isSymlink(link.path)) continue; // replaced by someone else
      rmSync(link.path, { recursive: true, force: true });
    }
    rmSync(entry.path, { recursive: true, force: true });
  }
  removeFromState(targets.map((t) => t.path));
  return targets;
}
