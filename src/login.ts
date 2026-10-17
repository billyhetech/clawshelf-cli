import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { type Api, ApiError } from './api.js';
import { saveToken } from './credentials.js';

export type LoginDeps = {
  print: (line: string) => void;
  openBrowser: (url: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/** Open a URL in the default browser; false when there is no way to. */
export function openBrowser(url: string): boolean {
  if (process.env.CLAWSHELF_NO_BROWSER || process.env.CI) return false;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  if (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return false;
  }
  try {
    const child = spawn(cmd as string, args as string[], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export const defaultLoginDeps: LoginDeps = {
  print: (line) => console.error(line),
  openBrowser,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Show the code in groups of four so it matches the web page (ABCD-EFGH). */
export function formatUserCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

export class LoginError extends Error {}

/**
 * Browser login (OAuth device authorization): show a code, let the user
 * approve it on clawshelf.com, then swap the one-time session for a CLI token.
 */
export async function login(
  api: Api,
  deps: LoginDeps = defaultLoginDeps
): Promise<{ email: string; storage: 'keyring' | 'file' }> {
  const start = await api.startDeviceLogin();
  const code = formatUserCode(start.userCode);

  deps.print('');
  deps.print(`  Your code: ${code}`);
  deps.print('');
  const opened = deps.openBrowser(start.verificationUriComplete);
  deps.print(
    opened
      ? `  Opened ${start.verificationUri} in your browser. Check the code matches and click Authorize.`
      : `  Open ${start.verificationUriComplete} in a browser, check the code matches, and click Authorize.`
  );
  deps.print('  Waiting for approval…');

  const deadline = deps.now() + start.expiresIn * 1000;
  let interval = Math.max(start.interval, 1) * 1000;

  while (deps.now() < deadline) {
    await deps.sleep(interval);
    const result = await api.pollDeviceLogin(start.deviceCode);
    if (result.status !== 'approved') {
      if (result.status === 'denied')
        throw new LoginError('Login was denied in the browser.');
      if (result.status === 'expired') break;
      if (result.status === 'slow_down') interval += 5000;
      continue;
    }

    try {
      const { token, email } = await api.exchangeSession(
        result.sessionToken,
        hostname().slice(0, 48) || 'unknown device'
      );
      const storage = await saveToken(api.baseUrl, token);
      api.setToken(token);
      return { email, storage };
    } catch (error) {
      if (error instanceof ApiError) throw new LoginError(error.message);
      throw error;
    }
  }
  throw new LoginError(
    'The code expired before it was approved. Run `clawshelf login` again.'
  );
}
