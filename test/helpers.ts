import { zipSync } from 'fflate';
import { Api } from '../src/api.js';
import { sha256 } from '../src/archive.js';

const enc = new TextEncoder();

export function skillMd(name: string, body = 'Do the thing.'): string {
  return `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n# ${name}\n\n${body}\n`;
}

/** Build a ZIP from { path: text } */
export function zip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, enc.encode(v)])
    )
  );
}

type FakeSkill = {
  slug: string;
  name: string;
  version?: string;
  isFree?: boolean;
  access?: string;
  external?: boolean;
  status?: string;
  zip?: Uint8Array;
  /** Override the X-Archive-Sha256 header */
  headerSha?: string;
};

/** A fake ClawShelf API: lookup + download from an in-memory catalog. */
export function fakeApi(catalog: FakeSkill[], token: string | null = null) {
  const calls: string[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/api/cli/skills') {
      const slugs = (url.searchParams.get('slugs') ?? '').split(',');
      const skills = catalog
        .filter((s) => slugs.includes(s.slug))
        .map((s) => ({
          slug: s.slug,
          name: s.name,
          title: s.name,
          type: 'skill',
          version: s.version ?? '1.0.0',
          isFree: s.isFree ?? true,
          status: s.status ?? 'active',
          access: s.access ?? 'granted',
          archiveSha256: s.zip ? sha256(s.zip) : null,
          external: s.external ?? false,
          installCommand: s.external
            ? `npx skills add acme/x --skill ${s.name}`
            : null,
          pageUrl: `https://clawshelf.com/skill/${s.slug}`,
          unlockUrl: 'https://clawshelf.com/pricing',
        }));
      return json({
        skills,
        notFound: slugs.filter((s) => !catalog.some((c) => c.slug === s)),
      });
    }
    const m = url.pathname.match(/^\/api\/cli\/skills\/([^/]+)\/download$/);
    if (m) {
      const s = catalog.find((c) => c.slug === m[1]);
      if (!s?.zip) return json({ error: 'not_found', message: 'nope' }, 404);
      return new Response(s.zip as BodyInit, {
        headers: {
          'content-length': String(s.zip.byteLength),
          'x-archive-sha256': s.headerSha ?? sha256(s.zip),
          'x-skill-name': s.name,
          'x-skill-version': s.version ?? '1.0.0',
        },
      });
    }
    return json({ error: 'not_found', message: url.pathname }, 404);
  }) as typeof fetch;
  return { api: new Api('https://clawshelf.com', token, fetchImpl), calls };
}
