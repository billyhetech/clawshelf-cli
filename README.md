# clawshelf

Install [ClawShelf](https://clawshelf.com) skills into Claude Code, Codex, Cursor, OpenClaw and every other [Agent Skills](https://agentskills.io) client.

```bash
npx clawshelf@latest install basic-memory
```

Free skills install without an account. Paid skills open your browser once to log in, and then install, update and list like the free ones.

## Commands

```text
clawshelf install <slug...>   Install skills
clawshelf update [slug...]    Update installed skills (all when none given)
clawshelf list                Show installed skills
clawshelf remove <slug...>    Remove installed skills
clawshelf login               Log in through your browser (for paid skills)
clawshelf status              Show the logged-in account
clawshelf logout              Log out on this machine
```

Install options:

| Option | What it does |
|---|---|
| `-a, --agent <id>` | Install for this agent (repeatable). See the table below |
| `-t, --target <dir>` | Install into this skills folder instead, with no links. For agents not in the table |
| `-p, --project` | Install into the current project (`./.agents/skills`) instead of your home folder |
| `--copy` | Copy into each agent's folder instead of symlinking |
| `--force` | Replace folders clawshelf didn't install (the old folder is backed up first) |
| `-y, --yes` | Don't ask; install for every agent found on this machine |
| `--json` | Machine-readable output for `install`, `update`, `list` and `status` |

Exit codes: `0` ok, `1` error, `2` needs a purchase or Pro membership, `3` needs a login.

## Where skills go

One main copy lives in `~/.agents/skills/<name>`, the shared folder that Codex, Cline, Warp, Zed and others read directly. Every other agent you pick gets a symlink to it, so an update reaches all of them at once. On Windows without developer mode the link is a directory junction, or a copy if that fails.

| Agent | `--agent` | Global folder |
|---|---|---|
| Claude Code | `claude-code` | `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) |
| Codex | `codex` | `~/.agents/skills` |
| Cursor | `cursor` | `~/.cursor/skills` |
| OpenClaw | `openclaw` | `~/.openclaw/skills` |
| Gemini CLI | `gemini-cli` | `~/.gemini/skills` |
| GitHub Copilot | `github-copilot` | `~/.copilot/skills` |
| OpenCode | `opencode` | `~/.config/opencode/skills` |
| Windsurf | `windsurf` | `~/.codeium/windsurf/skills` |
| Cline, Warp, Zed | `cline`, `warp`, `zed` | `~/.agents/skills` |
| Amp | `amp` | `~/.config/agents/skills` |
| Kiro CLI, Qwen Code, Roo Code, Trae, Goose, Antigravity | `kiro-cli`, `qwen-code`, `roo`, `trae`, `goose`, `antigravity` | their own `skills` folders |

The paths follow the open [`skills` CLI](https://github.com/vercel-labs/skills). For an agent that isn't listed, use `--target <its skills folder>`.

## Security

- **Login**: OAuth device authorization. You approve a short code on clawshelf.com; the CLI never sees your password. The one-time login session is swapped for a CLI-only token that can't sign in to the website, and the site deletes the session.
- **Token storage**: macOS Keychain, Windows Credential Manager or Linux Secret Service. Without a keyring, `~/.clawshelf/cli/credentials.json`, readable only by you. The token is never printed, logged or passed on the command line. A login lapses after 30 days without use; revoke it anytime in Settings → API Keys or with `clawshelf logout`.
- **Archives**: each download's SHA-256 must match the server's `X-Archive-Sha256`. The archive is checked before anything is written: absolute paths, `..`, Windows device names, case-insensitive duplicates, more than 1000 files or 25 MB unpacked, and a SKILL.md `name` that doesn't match its folder are all rejected. Files go to a staging folder first and are moved into place in one step; a replaced folder is kept in `~/.clawshelf/cli/backups`.
- **Nothing runs**: the CLI never executes scripts from a skill.
- **Your folders are safe**: the CLI only replaces or removes folders it installed (recorded in `~/.clawshelf/cli/installed.json`), unless you pass `--force`.

## For agents

Read <https://clawshelf.com/install/agent.md>, or a skill's own `https://clawshelf.com/skill/<slug>/install.md`. When you run the CLI yourself, pass `--agent <your id>` (or `--yes`) so it doesn't wait for input.

## Development

Node.js 20 or newer.

```bash
npm install
npm test            # Vitest; runs in a temporary HOME with the keyring off
npm run typecheck
npm run lint
npm run build       # dist/index.js
node dist/index.js --base-url http://localhost:3000 install <slug>
```

`CLAWSHELF_URL` sets the site too. `CLAWSHELF_KEYRING=off` forces the credentials file and `CLAWSHELF_NO_BROWSER=1` stops the browser from opening.

Releases publish to npm from GitHub Actions with provenance when a `v*` GitHub release is published (see `.github/workflows/publish.yml`).

## License

MIT
