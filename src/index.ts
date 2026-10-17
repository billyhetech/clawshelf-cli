import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isCancel, multiselect } from '@clack/prompts';
import { AGENTS, type Agent, detectAgents, findAgent } from './agents.js';
import { Api, ApiError, DEFAULT_BASE_URL } from './api.js';
import { deleteToken, getToken } from './credentials.js';
import {
  InstallError,
  type InstallPlan,
  install,
  remove,
  update,
} from './install.js';
import { LoginError, login } from './login.js';
import { readState } from './state.js';
import { VERSION } from './version.js';

const HELP = `clawshelf ${VERSION} — install ClawShelf skills into any Agent Skills client

Usage:
  clawshelf install <slug...>   Install skills (free ones need no login)
  clawshelf update [slug...]    Update installed skills (all when none given)
  clawshelf list                Show installed skills
  clawshelf remove <slug...>    Remove installed skills
  clawshelf login               Log in through your browser (for paid skills)
  clawshelf status              Show the logged-in account
  clawshelf logout              Log out on this machine

Install options:
  -a, --agent <id>     Install for this agent (repeatable). Ids: ${AGENTS.map((a) => a.id).join(', ')}
  -t, --target <dir>   Install into this skills folder instead (no links)
  -p, --project        Install into the current project instead of your home folder
      --copy           Copy into each agent's folder instead of symlinking
      --force          Replace folders not installed by clawshelf (backed up first)
  -y, --yes            Don't ask; install for every agent found on this machine

Other options:
      --json           Machine-readable output (install, update, list, status)
      --base-url <url> ClawShelf site (default ${DEFAULT_BASE_URL}, or CLAWSHELF_URL)
  -h, --help           Show this help
  -v, --version        Show the version

Exit codes: 0 ok, 1 error, 2 needs a purchase or Pro, 3 needs login.
Docs: https://clawshelf.com/install/agent.md`;

const out = (line = '') => console.log(line);
const err = (line = '') => console.error(line);
const tilde = (path: string) => {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
};

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string', short: 'a', multiple: true },
      target: { type: 'string', short: 't' },
      project: { type: 'boolean', short: 'p', default: false },
      copy: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      json: { type: 'boolean', default: false },
      'base-url': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
}

type Flags = ReturnType<typeof parse>['values'];

async function choosePlan(flags: Flags): Promise<InstallPlan> {
  const project = flags.project ? process.cwd() : null;
  const base = {
    project,
    copy: Boolean(flags.copy),
    force: Boolean(flags.force),
  };

  if (flags.target) {
    if (flags.agent?.length) {
      throw new InstallError('Use either --agent or --target, not both.', 1);
    }
    return { ...base, target: resolve(flags.target), agents: [] };
  }

  if (flags.agent?.length) {
    const agents: Agent[] = [];
    for (const id of flags.agent.flatMap((a) => a.split(','))) {
      if (id === 'shared') continue;
      const agent = findAgent(id.trim());
      if (!agent) {
        throw new InstallError(
          `Unknown agent "${id}". Known ids: shared, ${AGENTS.map((a) => a.id).join(', ')}. For any other agent, ask the user for its skills folder and use --target <dir>.`,
          1
        );
      }
      agents.push(agent);
    }
    return { ...base, target: null, agents };
  }

  const detected = detectAgents();
  if (flags.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { ...base, target: null, agents: detected };
  }
  const picked = await multiselect({
    message: `Install for which agents? (the main copy goes in ${project ? '.agents/skills' : '~/.agents/skills'})`,
    options: AGENTS.map((a) => ({
      value: a.id,
      label: a.name,
      hint: detected.includes(a) ? 'found' : undefined,
    })),
    initialValues: detected.map((a) => a.id),
    required: false,
  });
  if (isCancel(picked)) throw new InstallError('Cancelled.', 1);
  return {
    ...base,
    target: null,
    agents: AGENTS.filter((a) => (picked as string[]).includes(a.id)),
  };
}

/** Run a command; when it needs a login and we can ask for one, log in and retry once. */
async function withLogin<T>(api: Api, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof InstallError) || error.code !== 'login_required')
      throw error;
    err('This skill needs a ClawShelf login.');
    const { email } = await login(api);
    err(`  Logged in as ${email}.`);
    return run();
  }
}

function describeLinks(entry: ReturnType<typeof readState>[number]): string[] {
  return entry.links.map((l) => {
    const name = findAgent(l.agent)?.name ?? l.agent;
    return l.mode === 'shared'
      ? `    ${name}: reads the main copy`
      : `    ${name}: ${l.mode} at ${tilde(l.path)}`;
  });
}

async function main(argv: string[]): Promise<number> {
  const { values: flags, positionals } = parse(argv);
  if (flags.version) {
    out(VERSION);
    return 0;
  }
  const [command, ...args] = positionals;
  if (flags.help || !command || command === 'help') {
    out(HELP);
    return command || flags.help ? 0 : 1;
  }

  const baseUrl = (
    flags['base-url'] ??
    process.env.CLAWSHELF_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, '');
  const api = new Api(baseUrl, await getToken(baseUrl));
  const print = (line: string) => err(line);

  switch (command) {
    case 'login': {
      const { email, storage } = await login(api);
      out(`Logged in as ${email}.`);
      if (storage === 'file') {
        err(
          '  No system keyring found: the login is saved in ~/.clawshelf/cli/credentials.json (only you can read it).'
        );
      }
      return 0;
    }

    case 'logout': {
      await api.logout();
      await deleteToken(baseUrl);
      out('Logged out.');
      return 0;
    }

    case 'status': {
      if (!api.loggedIn) {
        if (flags.json) out(JSON.stringify({ loggedIn: false }));
        else
          out(
            'Not logged in. Free skills install without a login; run `clawshelf login` for paid ones.'
          );
        return 0;
      }
      try {
        const me = await api.whoami();
        if (flags.json) out(JSON.stringify({ loggedIn: true, ...me }));
        else
          out(
            `Logged in as ${me.email} (${me.plan === 'free' ? 'free account' : me.plan === 'pro' ? 'Pro' : 'Lifetime'}).`
          );
        return 0;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await deleteToken(baseUrl);
          if (flags.json) out(JSON.stringify({ loggedIn: false }));
          else out('Your login expired or was revoked. Run `clawshelf login`.');
          return 0;
        }
        throw error;
      }
    }

    case 'install':
    case 'add':
    case 'i': {
      if (args.length === 0)
        throw new InstallError(
          'Name at least one skill: clawshelf install <slug>',
          1
        );
      const plan = await choosePlan(flags);
      const installed = await withLogin(api, () =>
        install(args, plan, { api, print })
      );
      if (flags.json) {
        out(JSON.stringify({ installed }, null, 2));
        return 0;
      }
      for (const entry of installed) {
        out(
          `Installed ${entry.name}${entry.version ? ` ${entry.version}` : ''} → ${tilde(entry.path)}`
        );
        for (const line of describeLinks(entry)) out(line);
      }
      if (!plan.target && plan.agents.length === 0) {
        out(
          '  No agent was found or chosen; only the shared folder (~/.agents/skills) was used. Add --agent <id> for others.'
        );
      }
      out("Restart your agent if it doesn't pick up new skills on its own.");
      return 0;
    }

    case 'update':
    case 'upgrade': {
      const result = await withLogin(api, () =>
        update(args, AGENTS, { api, print })
      );
      if (flags.json) {
        out(
          JSON.stringify(
            result,
            (k, v) => (v instanceof Error ? v.message : v),
            2
          )
        );
      } else {
        for (const entry of result.updated)
          out(`Updated ${entry.name} to ${entry.version ?? 'latest'}`);
        for (const slug of result.current) out(`${slug} is up to date`);
        for (const f of result.failed)
          err(`Could not update ${f.slug}: ${f.error.message}`);
        if (
          !result.updated.length &&
          !result.current.length &&
          !result.failed.length
        ) {
          out('Nothing installed by clawshelf yet.');
        }
      }
      return result.failed.length
        ? Math.max(...result.failed.map((f) => f.error.exitCode))
        : 0;
    }

    case 'list':
    case 'ls': {
      const state = readState();
      if (flags.json) {
        out(JSON.stringify({ installed: state }, null, 2));
        return 0;
      }
      if (state.length === 0) {
        out(
          'Nothing installed by clawshelf yet. Try: clawshelf install <slug>'
        );
        return 0;
      }
      for (const entry of state) {
        out(
          `${entry.name}${entry.version ? ` ${entry.version}` : ''}  ${tilde(entry.path)}`
        );
        for (const line of describeLinks(entry)) out(line);
      }
      return 0;
    }

    case 'remove':
    case 'rm':
    case 'uninstall': {
      if (args.length === 0)
        throw new InstallError(
          'Name at least one skill: clawshelf remove <slug>',
          1
        );
      for (const entry of remove(args))
        out(`Removed ${entry.name} from ${tilde(entry.path)}`);
      return 0;
    }

    default:
      err(`Unknown command "${command}".\n`);
      out(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof InstallError) {
      err(error.message);
      process.exitCode = error.exitCode;
    } else if (error instanceof LoginError) {
      err(error.message);
      process.exitCode = 3;
    } else if (error instanceof ApiError) {
      err(error.message);
      process.exitCode = error.status === 402 ? 2 : 1;
    } else if (
      error instanceof Error &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      err(`${error.message}\nRun \`clawshelf --help\` for usage.`);
      process.exitCode = 1;
    } else {
      err(
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      );
      process.exitCode = 1;
    }
  }
);
