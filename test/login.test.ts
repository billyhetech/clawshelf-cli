import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import { deleteToken, getToken } from '../src/credentials.js';
import {
  type LoginDeps,
  LoginError,
  formatUserCode,
  login,
} from '../src/login.js';
import { credentialsFile } from '../src/paths.js';
import { VERSION } from '../src/version.js';

const BASE = 'https://clawshelf.com';
const CLI_TOKEN = `cst_${'d'.repeat(64)}`;

/** Server that answers the device flow with a scripted list of poll results. */
function server(polls: Array<Record<string, string>>, exchange = true) {
  const requests: { path: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({
      path: url.pathname,
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    switch (url.pathname) {
      case '/api/auth/device/code':
        return json({
          device_code: 'dev-code',
          user_code: 'WDJBMJHT',
          verification_uri: `${BASE}/device`,
          verification_uri_complete: `${BASE}/device?user_code=WDJBMJHT`,
          expires_in: 600,
          interval: 5,
        });
      case '/api/auth/device/token': {
        const next = polls.shift() ?? { error: 'authorization_pending' };
        return json(next, next.access_token ? 200 : 400);
      }
      case '/api/cli/token':
        return exchange
          ? json({
              token: CLI_TOKEN,
              email: 'a@b.com',
              expiresAt: '2026-11-16T00:00:00Z',
            })
          : json({ error: 'invalid_grant', message: 'Login expired' }, 401);
      default:
        return json({ error: 'not_found' }, 404);
    }
  }) as typeof fetch;
  return { api: new Api(BASE, null, fetchImpl), requests };
}

function deps() {
  let clock = 0;
  const printed: string[] = [];
  const opened: string[] = [];
  const sleeps: number[] = [];
  const d: LoginDeps = {
    print: (l) => printed.push(l),
    openBrowser: (url) => {
      opened.push(url);
      return true;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { d, printed, opened, sleeps };
}

describe('login', () => {
  it('shows the code, polls until approved, swaps the session and stores the token', async () => {
    const { api, requests } = server([
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'session-token', token_type: 'Bearer' },
    ]);
    const { d, printed, opened, sleeps } = deps();

    const result = await login(api, d);

    expect(result).toEqual({ email: 'a@b.com', storage: 'file' });
    expect(printed.join('\n')).toContain('WDJB-MJHT');
    expect(opened).toEqual([`${BASE}/device?user_code=WDJBMJHT`]);
    // slow_down adds 5 seconds to the interval
    expect(sleeps).toEqual([5000, 5000, 10000]);
    // The session token is only ever sent to the exchange endpoint
    const exchange = requests.find((r) => r.path === '/api/cli/token');
    expect(exchange?.auth).toBe('Bearer session-token');
    expect(
      requests.filter((r) => r.auth === 'Bearer session-token')
    ).toHaveLength(1);
    expect(
      requests.find((r) => r.path === '/api/auth/device/code')?.body
    ).toEqual({
      client_id: 'clawshelf-cli',
    });
    // Saved and usable
    expect(await getToken(BASE)).toBe(CLI_TOKEN);
    expect(api.loggedIn).toBe(true);
    expect(printed.join('\n')).not.toContain(CLI_TOKEN);
  });

  it('fails on denial', async () => {
    const { api } = server([{ error: 'access_denied' }]);
    await expect(login(api, deps().d)).rejects.toThrow(/denied/);
    expect(await getToken(BASE)).toBeNull();
  });

  it('fails when the code expires', async () => {
    const { api } = server([{ error: 'expired_token' }]);
    await expect(login(api, deps().d)).rejects.toThrow(LoginError);
  });

  it('gives up after expires_in even if the server keeps saying pending', async () => {
    const { api } = server([]);
    const { d, sleeps } = deps();
    await expect(login(api, d)).rejects.toThrow(/expired/);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(600_000);
  });

  it('surfaces a failed exchange', async () => {
    const { api } = server([{ access_token: 'session-token' }], false);
    await expect(login(api, deps().d)).rejects.toThrow(/Login expired/);
  });

  it('formats codes in groups of four', () => {
    expect(formatUserCode('WDJBMJHT')).toBe('WDJB-MJHT');
  });
});

describe('credentials file (no keyring)', () => {
  it('is readable by the owner only and keeps sites apart', async () => {
    const { api } = server([{ access_token: 'session-token' }]);
    await login(api, deps().d);
    const file = credentialsFile();
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      'clawshelf.com': CLI_TOKEN,
    });
    expect(await getToken('http://localhost:3000')).toBeNull();

    await deleteToken(BASE);
    expect(await getToken(BASE)).toBeNull();
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    expect(VERSION).toBe(pkg.version);
  });
});
