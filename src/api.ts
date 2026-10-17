import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://clawshelf.com';
export const CLIENT_ID = 'clawshelf-cli';

export type Access =
  | 'granted'
  | 'login_required'
  | 'purchase_required'
  | 'membership_required';

export type RemoteSkill = {
  slug: string;
  name: string;
  title: string;
  type: 'skill' | 'pack';
  version: string | null;
  isFree: boolean;
  status: string;
  access: Access;
  archiveSha256: string | null;
  external: boolean;
  installCommand: string | null;
  pageUrl: string;
  unlockUrl: string;
};

export type Download = {
  bytes: Uint8Array;
  sha256: string;
  name: string;
  version: string | null;
};

/** An error the server explained (`{ error, message, url }`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly url?: string
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export class Api {
  constructor(
    readonly baseUrl: string,
    private token: string | null,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  get loggedIn(): boolean {
    return this.token !== null;
  }

  private async request(
    path: string,
    init: RequestInit & { auth?: string | null } = {}
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('user-agent', `clawshelf-cli/${VERSION}`);
    const auth = init.auth === undefined ? this.token : init.auth;
    if (auth) headers.set('authorization', `Bearer ${auth}`);
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        headers,
        redirect: 'follow',
      });
    } catch (error) {
      throw new ApiError(
        0,
        'network',
        `Could not reach ${this.baseUrl}: ${(error as Error).message}`
      );
    }
    return res;
  }

  private async json<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!res.ok) {
      throw new ApiError(
        res.status,
        String(body?.error ?? 'http_error'),
        String(
          body?.message ??
            body?.error_description ??
            `Request failed (${res.status})`
        ),
        typeof body?.url === 'string' ? body.url : undefined
      );
    }
    return body as T;
  }

  // ── Device login (RFC 8628, Better Auth device-authorization) ──

  async startDeviceLogin(): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
  }> {
    const res = await this.request('/api/auth/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      auth: null,
    });
    const body = await this.json<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>(res);
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete,
      expiresIn: body.expires_in,
      interval: body.interval,
    };
  }

  /** One poll: the session token once approved, or the pending/denied state. */
  async pollDeviceLogin(
    deviceCode: string
  ): Promise<
    | { status: 'approved'; sessionToken: string }
    | { status: 'pending' | 'slow_down' | 'expired' | 'denied' }
  > {
    const res = await this.request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: CLIENT_ID,
      }),
      auth: null,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (res.ok && body.access_token) {
      return { status: 'approved', sessionToken: body.access_token };
    }
    switch (body.error) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down' };
      case 'expired_token':
        return { status: 'expired' };
      case 'access_denied':
        return { status: 'denied' };
      default:
        throw new ApiError(
          res.status,
          body.error ?? 'http_error',
          body.error_description ?? `Login failed (${res.status})`
        );
    }
  }

  /** Swap the one-time device session for a CLI token (the server deletes the session). */
  async exchangeSession(
    sessionToken: string,
    deviceName: string
  ): Promise<{ token: string; email: string; expiresAt: string }> {
    const res = await this.request('/api/cli/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceName }),
      auth: sessionToken,
    });
    return this.json(res);
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    await this.request('/api/cli/logout', { method: 'POST' }).catch(
      () => undefined
    );
  }

  async whoami(): Promise<{
    email: string;
    plan: 'free' | 'pro' | 'lifetime';
  }> {
    return this.json(await this.request('/api/cli/whoami'));
  }

  // ── Skills ──

  async lookup(
    slugs: string[]
  ): Promise<{ skills: RemoteSkill[]; notFound: string[] }> {
    const query = encodeURIComponent(slugs.join(','));
    return this.json(await this.request(`/api/cli/skills?slugs=${query}`));
  }

  async download(slug: string): Promise<Download> {
    const res = await this.request(
      `/api/cli/skills/${encodeURIComponent(slug)}/download`
    );
    if (!res.ok) await this.json(res); // throws ApiError
    const sha256 = res.headers.get('x-archive-sha256');
    const length = Number(res.headers.get('content-length'));
    const name = res.headers.get('x-skill-name');
    if (!sha256 || !name || !Number.isFinite(length)) {
      throw new ApiError(
        res.status,
        'bad_response',
        'Download is missing its checksum headers'
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength !== length) {
      throw new ApiError(
        res.status,
        'bad_response',
        'Download was cut short; try again'
      );
    }
    return {
      bytes,
      sha256,
      name,
      version: res.headers.get('x-skill-version') || null,
    };
  }
}
