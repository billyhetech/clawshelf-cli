import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where each agent loads skills from. Paths follow the open `skills` CLI
 * (github.com/vercel-labs/skills) so both tools agree. Agents whose global
 * folder is the shared `~/.agents/skills` read the main copy directly; the
 * others get a symlink to it.
 */
export type Agent = {
  id: string;
  name: string;
  /** Global skills folder */
  globalDir: (home: string, env: NodeJS.ProcessEnv) => string;
  /** Project skills folder, relative to the project root */
  projectDir: string;
  /** Folder whose presence means the agent is installed */
  detect: (home: string, env: NodeJS.ProcessEnv) => string;
};

export const SHARED_GLOBAL_DIR = (home: string) =>
  join(home, '.agents', 'skills');
export const SHARED_PROJECT_DIR = join('.agents', 'skills');

const claudeHome = (home: string, env: NodeJS.ProcessEnv) =>
  env.CLAUDE_CONFIG_DIR || join(home, '.claude');

const shared = (id: string, name: string, configDir: string): Agent => ({
  id,
  name,
  globalDir: SHARED_GLOBAL_DIR,
  projectDir: SHARED_PROJECT_DIR,
  detect: (home) => join(home, configDir),
});

export const AGENTS: Agent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    globalDir: (home, env) => join(claudeHome(home, env), 'skills'),
    projectDir: join('.claude', 'skills'),
    detect: claudeHome,
  },
  shared('codex', 'Codex', '.codex'),
  {
    id: 'cursor',
    name: 'Cursor',
    globalDir: (home) => join(home, '.cursor', 'skills'),
    projectDir: SHARED_PROJECT_DIR,
    detect: (home) => join(home, '.cursor'),
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    globalDir: (home) => join(home, '.openclaw', 'skills'),
    projectDir: 'skills',
    detect: (home) => join(home, '.openclaw'),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    globalDir: (home) => join(home, '.gemini', 'skills'),
    projectDir: SHARED_PROJECT_DIR,
    detect: (home) => join(home, '.gemini'),
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    globalDir: (home) => join(home, '.copilot', 'skills'),
    projectDir: SHARED_PROJECT_DIR,
    detect: (home) => join(home, '.copilot'),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    globalDir: (home) => join(home, '.config', 'opencode', 'skills'),
    projectDir: SHARED_PROJECT_DIR,
    detect: (home) => join(home, '.config', 'opencode'),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    globalDir: (home) => join(home, '.codeium', 'windsurf', 'skills'),
    projectDir: join('.windsurf', 'skills'),
    detect: (home) => join(home, '.codeium', 'windsurf'),
  },
  shared('cline', 'Cline', '.cline'),
  shared('warp', 'Warp', '.warp'),
  shared('zed', 'Zed', join('.config', 'zed')),
  {
    id: 'amp',
    name: 'Amp',
    globalDir: (home) => join(home, '.config', 'agents', 'skills'),
    projectDir: SHARED_PROJECT_DIR,
    detect: (home) => join(home, '.config', 'amp'),
  },
  {
    id: 'kiro-cli',
    name: 'Kiro CLI',
    globalDir: (home) => join(home, '.kiro', 'skills'),
    projectDir: join('.kiro', 'skills'),
    detect: (home) => join(home, '.kiro'),
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    globalDir: (home) => join(home, '.qwen', 'skills'),
    projectDir: join('.qwen', 'skills'),
    detect: (home) => join(home, '.qwen'),
  },
  {
    id: 'roo',
    name: 'Roo Code',
    globalDir: (home) => join(home, '.roo', 'skills'),
    projectDir: join('.roo', 'skills'),
    detect: (home) => join(home, '.roo'),
  },
  {
    id: 'trae',
    name: 'Trae',
    globalDir: (home) => join(home, '.trae', 'skills'),
    projectDir: join('.trae', 'skills'),
    detect: (home) => join(home, '.trae'),
  },
  {
    id: 'goose',
    name: 'Goose',
    globalDir: (home) => join(home, '.config', 'goose', 'skills'),
    projectDir: join('.goose', 'skills'),
    detect: (home) => join(home, '.config', 'goose'),
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    globalDir: (home) => join(home, '.gemini', 'antigravity', 'skills'),
    projectDir: SHARED_PROJECT_DIR,
    detect: (home) => join(home, '.gemini', 'antigravity'),
  },
];

export function findAgent(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Agents installed on this machine (their config folder exists). */
export function detectAgents(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): Agent[] {
  return AGENTS.filter((a) => existsSync(a.detect(home, env)));
}

/** The skills folder an agent reads, for the chosen scope. */
export function agentSkillsDir(
  agent: Agent,
  scope: { project: string | null },
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  return scope.project
    ? join(scope.project, agent.projectDir)
    : agent.globalDir(home, env);
}

/** The shared folder that holds the main copy of every skill. */
export function sharedSkillsDir(
  scope: { project: string | null },
  home = homedir()
): string {
  return scope.project
    ? join(scope.project, SHARED_PROJECT_DIR)
    : SHARED_GLOBAL_DIR(home);
}
