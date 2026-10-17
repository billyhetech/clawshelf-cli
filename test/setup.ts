import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

// Tests never read or write the real keyring, home folder or agent folders
process.env.CLAWSHELF_KEYRING = 'off';
process.env.CLAWSHELF_NO_BROWSER = '1';
const realHome = process.env.HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'clawshelf-cli-test-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  const home = process.env.HOME;
  if (home && home !== realHome && home.includes('clawshelf-cli-test-')) {
    rmSync(home, { recursive: true, force: true });
  }
});
