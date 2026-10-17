import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { credentialsFile } from './paths.js';

/**
 * The CLI token lives in the OS keyring (macOS Keychain, Windows Credential
 * Manager, Linux Secret Service). Without one (headless Linux, CI), it falls
 * back to a file only the user can read. The token is never printed.
 */
const SERVICE = 'clawshelf-cli';

type Keyring = {
  get(account: string): string | null;
  set(account: string, token: string): void;
  delete(account: string): void;
};

let keyringPromise: Promise<Keyring | null> | null = null;

async function loadKeyring(): Promise<Keyring | null> {
  if (process.env.CLAWSHELF_KEYRING === 'off') return null;
  try {
    const { Entry } = await import('@napi-rs/keyring');
    const keyring: Keyring = {
      get: (account) => new Entry(SERVICE, account).getPassword() ?? null,
      set: (account, token) => new Entry(SERVICE, account).setPassword(token),
      delete: (account) => {
        new Entry(SERVICE, account).deleteCredential();
      },
    };
    // Probe once: a missing Secret Service throws here, not at import
    keyring.get('__probe__');
    return keyring;
  } catch {
    return null;
  }
}

function keyring(): Promise<Keyring | null> {
  keyringPromise ??= loadKeyring();
  return keyringPromise;
}

type FileStore = Record<string, string>;

function readFileStore(): FileStore {
  try {
    return JSON.parse(readFileSync(credentialsFile(), 'utf8')) as FileStore;
  } catch {
    return {};
  }
}

function writeFileStore(store: FileStore): void {
  const file = credentialsFile();
  if (Object.keys(store).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Tokens are kept per site (production and a local dev server never mix). */
function accountFor(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export async function getToken(baseUrl: string): Promise<string | null> {
  const account = accountFor(baseUrl);
  const kr = await keyring();
  if (kr) {
    try {
      const token = kr.get(account);
      if (token) return token;
    } catch {
      // fall through to the file
    }
  }
  return readFileStore()[account] ?? null;
}

/** Saves the token; returns where it went so `login` can say so. */
export async function saveToken(
  baseUrl: string,
  token: string
): Promise<'keyring' | 'file'> {
  const account = accountFor(baseUrl);
  const kr = await keyring();
  if (kr) {
    try {
      kr.set(account, token);
      // Don't leave an older copy in the file
      const store = readFileStore();
      if (account in store) {
        delete store[account];
        writeFileStore(store);
      }
      return 'keyring';
    } catch {
      // fall back to the file
    }
  }
  writeFileStore({ ...readFileStore(), [account]: token });
  return 'file';
}

export async function deleteToken(baseUrl: string): Promise<void> {
  const account = accountFor(baseUrl);
  const kr = await keyring();
  if (kr) {
    try {
      kr.delete(account);
    } catch {
      // nothing stored there
    }
  }
  const store = readFileStore();
  if (account in store) {
    delete store[account];
    writeFileStore(store);
  }
}

/** For tests: forget the cached keyring decision. */
export function resetKeyringCache(): void {
  keyringPromise = null;
}
