import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.3.1 / Task 14: this file was notify's egress invariant test (MUST-9.4). It is now the
 * WHOLE APP's egress invariant test: every tree that is allowed to leave the machine —
 * src/lib/notify/ and, as of the update feature, src/lib/update/ — is scanned here, by the
 * same table-driven, comment-stripped, line-scoped checks. A third opt-in tree added later
 * extends the tables below; it does not get its own copy of this file.
 *
 * v1.64.0: the third tree is src/lib/ai/, the optional local AI helper, which may talk only to a
 * model server on the household's own network. Its checks are at the end of this file.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const notifyDir = path.join(root, 'src/lib/notify');
const updateDir = path.join(root, 'src/lib/update');
const predictDir = path.join(root, 'src/lib/predict');
const aiDir = path.join(root, 'src/lib/ai');
const srcDir = path.join(root, 'src');
const pageDir = path.join(root, 'src/app/(app)/settings/notifications');
const rel = (file: string) => path.relative(root, file).replace(/\\/g, '/');

/**
 * Quoted string literals containing `://`, found line by line and ignoring comment lines.
 *
 * Line-scoped on purpose: a whole-file regex pairs a quote from one statement with a `://`
 * inside a docblock hundreds of lines later and reports a URL that does not exist. Comment
 * lines are skipped because prose legitimately writes the endpoint out (`POST
 * https://api.telegram.org/bot<token>/sendMessage`) — what matters is whether the CODE
 * carries a second destination.
 */
function urlLiterals(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .flatMap((line) => line.match(/(['"`])[^'"`]*:\/\/[^'"`]*\1/g) ?? []);
}

/**
 * The repo's established stripComments pattern (see tests/ops/install.test.ts). Without it,
 * github.ts's own docblock -- which spells out `fetch(` in prose while explaining MUST-8.5 --
 * would inflate its own call-site count from 2 to 4. Comments proving a scanner right must not
 * be able to make the scanner wrong.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * MUST-8.8 item 2: table-driven over BOTH egress trees. `expected` counts literal `fetch(`
 * CALL SITES, not endpoints.
 *
 * Pre-flight ruling F1: github.ts deliberately keeps TWO inlined fetch call sites — one per
 * endpoint (fetchLatestRelease, fetchRemoteChangelog) — each with `assertGithubUrl()` on the
 * line immediately above it (MUST-8.5), rather than folding both into a shared private
 * request helper. That adjacency is the property a refactor loses first, and the source-level
 * scanner below (MUST-8.5) checks for it directly, so the count here is 2, not 1.
 */
const FETCH_SITES: { dir: string; file: string; expected: number }[] = [
  { dir: notifyDir, file: 'src/lib/notify/send/telegram.ts', expected: 2 }, // sendMessage, getUpdates
  { dir: updateDir, file: 'src/lib/update/github.ts', expected: 2 }, // fetchLatestRelease, fetchRemoteChangelog
  { dir: updateDir, file: 'src/lib/update/watchtower.ts', expected: 1 }, // /v1/update
];

it('every fetch( under src/lib/notify/ and src/lib/update/ is on the allowlist, with the expected count', () => {
  const counts = new Map<string, number>();
  const offenders: string[] = [];
  for (const dir of [notifyDir, updateDir, predictDir]) {
    for (const file of filesUnder(dir)) {
      const calls = stripComments(fs.readFileSync(file, 'utf8')).match(/(?<![.\w])fetch\s*\(/g)?.length ?? 0;
      if (calls === 0) continue;
      const name = rel(file);
      if (FETCH_SITES.some((site) => site.file === name)) counts.set(name, calls);
      else offenders.push(name);
    }
  }
  expect(offenders).toEqual([]);
  for (const site of FETCH_SITES) expect({ file: site.file, calls: counts.get(site.file) }).toEqual({ file: site.file, calls: site.expected });
});

describe('MUST-9.4 / AC3: the only outbound call sites', () => {
  it('the only URL literal containing :// is TELEGRAM_API_ORIGIN in egress.ts', () => {
    const offenders: { file: string; literal: string }[] = [];
    for (const file of filesUnder(notifyDir)) {
      if (rel(file) === 'src/lib/notify/egress.ts') continue;
      for (const literal of urlLiterals(file)) offenders.push({ file: rel(file), literal });
    }
    expect(offenders).toEqual([]);
    expect(urlLiterals(path.join(notifyDir, 'egress.ts'))).toEqual(["'https://api.telegram.org'"]);
  });

  it('MUST-9.1a: the settings page directory contains no fetch call at all', () => {
    for (const file of filesUnder(pageDir)) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/(?<![.\w])fetch\s*\(/);
    }
  });

  it('MUST-11.6: the guides render no <a href>, so no address on the page is clickable', () => {
    const guides = fs.readFileSync(path.join(pageDir, 'guides.tsx'), 'utf8');
    expect(guides).not.toMatch(/<a\s/);
    expect(guides).not.toMatch(/href=/);
  });

  it('MUST-9.1a: the page directory holds no :// STRING LITERAL — only JSX prose', () => {
    for (const file of filesUnder(pageDir)) {
      // guides.tsx writes `<code>https://</code>` as JSX text (the Custom-SMTP guide telling
      // the reader NOT to type a scheme into the Server field). That is prose a person
      // reads, not an address the server can use, and it is not a string literal.
      expect({ file: rel(file), literals: urlLiterals(file) }).toEqual({ file: rel(file), literals: [] });
    }
    const guides = fs.readFileSync(path.join(pageDir, 'guides.tsx'), 'utf8');
    expect(guides).toContain('<code>https://</code>');
  });
});

describe('MUST-2.3: the only :// literal under src/lib/update/ is GITHUB_API_ORIGIN in egress.ts', () => {
  it('no other file in the tree carries one, and watchtower.ts carries none at all', () => {
    const offenders: { file: string; literal: string }[] = [];
    for (const file of filesUnder(updateDir)) {
      if (rel(file) === 'src/lib/update/egress.ts') continue;
      for (const literal of urlLiterals(file)) offenders.push({ file: rel(file), literal });
    }
    expect(offenders).toEqual([]);
    expect(urlLiterals(path.join(updateDir, 'egress.ts'))).toEqual(["'https://api.github.com'"]);
    // watchtower.ts MUST contain no :// literal at all -- the URL comes from the environment.
    expect(urlLiterals(path.join(updateDir, 'watchtower.ts'))).toEqual([]);
  });
});

describe('MUST-1.1 and MUST-16.1: the predictive tree and the date-range files leave nothing', () => {
  const extraFiles = ['src/lib/date-range.ts', 'src/components/ui/DateRangePicker.tsx'];

  it('src/lib/predict/ holds no fetch( call site and no :// literal', () => {
    for (const file of filesUnder(predictDir)) {
      expect({ file: rel(file), literals: urlLiterals(file) }).toEqual({ file: rel(file), literals: [] });
      expect(stripComments(fs.readFileSync(file, 'utf8'))).not.toMatch(/(?<![.\w])fetch\s*\(/);
    }
  });

  it('the two date-range files hold no fetch( call site and no :// literal either', () => {
    for (const name of extraFiles) {
      const file = path.join(root, name);
      expect({ file: name, literals: urlLiterals(file) }).toEqual({ file: name, literals: [] });
      expect(stripComments(fs.readFileSync(file, 'utf8'))).not.toMatch(/(?<![.\w])fetch\s*\(/);
    }
  });
});

describe('no file under src/lib/notify/, src/lib/update/ or src/lib/ai/ imports an HTTP client library', () => {
  it('no tree pulls in a second way to make an outbound request', () => {
    const banned = /from\s+['"](axios|node-fetch|got|undici|superagent|ky|request)['"]/;
    for (const dir of [notifyDir, updateDir, predictDir, aiDir]) {
      for (const file of filesUnder(dir)) {
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(banned);
      }
    }
  });
});

/**
 * MUST-8.5: the assert is on the line immediately preceding each fetch(, in the style of
 * restore-seams.test.ts -- "immediately above" is the part a refactor loses first, and a
 * whole-file "the guard function is called somewhere in this file" check would not catch a
 * refactor that moved the fetch() above the guard, or behind an early return.
 */
describe('MUST-8.5: the assert is on the line immediately preceding each fetch(', () => {
  it('holds for every fetch( call site in github.ts and watchtower.ts', () => {
    const cases = [
      { file: 'src/lib/update/github.ts', guard: 'assertGithubUrl(' },
      { file: 'src/lib/update/watchtower.ts', guard: 'assertWatchtowerUrl(' },
    ];
    for (const { file, guard } of cases) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
      const fetchLines = lines
        .map((line, index) => ({ line, index }))
        // A docblock line can legitimately spell out `fetch(` in prose (github.ts's own
        // MUST-8.5 comment does exactly that) without being a real call site.
        .filter((entry) => {
          const trimmed = entry.line.trim();
          return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*') && /(?<![.\w])fetch\s*\(/.test(entry.line);
        });
      expect(fetchLines.length).toBeGreaterThan(0);
      for (const { index } of fetchLines) {
        const previous = (lines[index - 1] ?? '').trim();
        expect({ file, previous }).toEqual({ file, previous: expect.stringContaining(guard) as unknown as string });
      }
    }
  });
});

describe('MUST-2.1: the pure modules stay pure', () => {
  const pureModules: { dir: string; name: string }[] = [
    { dir: notifyDir, name: 'events.ts' },
    { dir: notifyDir, name: 'render.ts' },
    { dir: notifyDir, name: 'egress.ts' },
    { dir: notifyDir, name: 'evaluate/slots.ts' },
    { dir: updateDir, name: 'semver.ts' },
    { dir: updateDir, name: 'egress.ts' },
    { dir: predictDir, name: 'constants.ts' },
    { dir: predictDir, name: 'stats.ts' },
    { dir: predictDir, name: 'window.ts' },
    { dir: predictDir, name: 'suggest.ts' },
    { dir: predictDir, name: 'pace.ts' },
    { dir: predictDir, name: 'anomalies.ts' },
    { dir: path.join(root, 'src/lib'), name: 'date-range.ts' },
    // v1.64.0: the local AI's policy, schemas, prompts and types, and the shared private-address test.
    { dir: aiDir, name: 'lan.ts' },
    { dir: aiDir, name: 'schemas.ts' },
    { dir: aiDir, name: 'prompts.ts' },
    { dir: aiDir, name: 'types.ts' },
    { dir: path.join(root, 'src/lib/net'), name: 'private-address.ts' },
  ];
  for (const { dir, name } of pureModules) {
    it(`${rel(path.join(dir, name))} imports no @/db, no @/lib/env and no node builtin`, () => {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
      expect(source).not.toMatch(/from\s+['"]node:/);
    });
  }
});

describe('MUST-2.2: server-only modules never reach a client component', () => {
  it('no *-client.tsx has a VALUE import of a notify or update server-only module', () => {
    const clients = filesUnder(path.join(root, 'src/app')).filter((file) => file.endsWith('-client.tsx'));
    const banned = /from\s+['"]@\/lib\/(notify\/(crypto|config|outbox|raise|send|evaluate)|update\/(github|watchtower|state|check)|predict\/history)/;
    for (const file of clients) {
      // `import type { ... }` is erased before bundling and is how the client legitimately
      // names SmtpRecord / TargetRecord / DeliveryRow / UpdateSeverity. Only value imports
      // are the hazard.
      const offending = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => banned.test(line) && !/^import\s+type\b/.test(line));
      expect({ file: rel(file), offending }).toEqual({ file: rel(file), offending: [] });
    }
  });
});

describe('AC7: no console call in src/lib/notify/ can leak a subject, a body or a secret', () => {
  it('never interpolates subject, body, token, password or a decrypted secret', () => {
    const banned = /console\.[a-z]+\([^)]*\b(subject|body|botToken|password|secret|plaintext)\b/i;
    for (const file of filesUnder(notifyDir)) {
      const source = fs.readFileSync(file, 'utf8');
      const offending = source
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter((entry) => banned.test(entry.line));
      expect({ file: rel(file), offending }).toEqual({ file: rel(file), offending: [] });
    }
  });
});

describe('AC7: src/lib/update/ holds one Authorization literal and logs no credential', () => {
  it('the one Authorization header is in watchtower.ts, and no console call can leak it', () => {
    const authLines: string[] = [];
    const consoleOffenders: string[] = [];
    for (const file of filesUnder(updateDir)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        const trimmed = line.trim();
        // github.ts's own MUST-4.3 comment ("No Authorization.") is a single-line /** ... */
        // block, which a bare '//'/'*' prefix check does not catch -- the '/*' check below
        // does (same three-way skip urlLiterals() above already uses).
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        if (/Authorization/.test(trimmed)) authLines.push(`${rel(file)}: ${trimmed}`);
        if (/console\.[a-z]+\([^)]*\b(token|Authorization|bearer)\b/i.test(trimmed)) consoleOffenders.push(`${rel(file)}: ${trimmed}`);
      }
    }
    expect(authLines).toHaveLength(1);
    expect(authLines[0]).toContain('src/lib/update/watchtower.ts');
    expect(authLines[0]).toContain('Bearer ');
    expect(consoleOffenders).toEqual([]);
  });
});

describe('MUST-9.5: the scheduler never reaches a transport directly', () => {
  it('src/lib/scheduler.ts imports the tick pieces, not the senders', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/scheduler.ts'), 'utf8');
    expect(source).not.toMatch(/notify\/send/);
    expect(source).toContain('hasAnyEnabledTarget');
    expect(source).toContain('countPendingOutbox');
  });
});

/**
 * v1.64.0 (plan 2026-11-12, L2, L3 and A12). The local AI tree: one network file, LAN only, the
 * configured address checked on the line above its one request call, no credential, nothing logged
 * from a prompt or an answer, and no way in from a client component or the scheduler.
 */
const AI_CLIENT = 'src/lib/ai/client.ts';
/** Every module that can open a socket or resolve a name. Only the AI client may import one. */
const NETWORK_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:http|https|http2|dns|net|tls|dgram)(?:\/promises)?['"]/;
/**
 * A real request call: `.request(`, a bare `request(` or `x['request'](`, never `sendRequest(` and
 * never the word inside a sentence (string contents are blanked before the first match).
 */
const REQUEST_CALL = /(?<![\w$])request\s*\(/;
const REQUEST_BY_KEY = /\[\s*['"`]request['"`]\s*\]\s*\(/;
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1).)*\1/g;
const isRequestCall = (line: string) => REQUEST_CALL.test(line.replace(STRING_LITERAL, "''")) || REQUEST_BY_KEY.test(line);
const AI_CONSOLE_LEAK = /console\.[a-z]+\([^)]*\b(content|body|prompt|text|description|merchant|answer|fields|row|ocr)\b/i;
const AI_SERVER_ONLY = /from\s+['"]@\/lib\/ai\/(client|config|queue|suggestions|receipt)['"]/;
const AI_CREDENTIAL = /authorization|cookie|bearer/i;

function codeLines(source: string): { line: string; index: number }[] {
  return source
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

/** Each request call site and the line immediately above it. */
function requestSites(source: string): { previous: string }[] {
  const lines = source.split('\n');
  return codeLines(source)
    .filter(({ line }) => isRequestCall(line))
    .map(({ index }) => ({ previous: (lines[index - 1] ?? '').trim() }));
}

function isClientComponent(file: string, source: string): boolean {
  if (file.endsWith('-client.tsx')) return true;
  const first = stripComments(source).trimStart().split('\n')[0]?.trim() ?? '';
  return /^['"]use client['"];?$/.test(first);
}

describe('v1.64.0: src/lib/ai/ talks only to the configured LAN address', () => {
  const aiFiles = filesUnder(aiDir);

  it('has the tree to scan, so a rename cannot make these checks vacuous', () => {
    expect(aiFiles.map(rel)).toContain(AI_CLIENT);
    expect(aiFiles.length).toBeGreaterThanOrEqual(9);
  });

  it('holds no fetch( call site anywhere', () => {
    const offenders = aiFiles.filter((file) => /(?<![.\w])fetch\s*\(/.test(stripComments(fs.readFileSync(file, 'utf8')))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('holds no :// literal, and no :// outside a comment at all', () => {
    for (const file of aiFiles) {
      expect({ file: rel(file), literals: urlLiterals(file) }).toEqual({ file: rel(file), literals: [] });
      const scheme = stripComments(fs.readFileSync(file, 'utf8')).includes('://');
      expect({ file: rel(file), scheme }).toEqual({ file: rel(file), scheme: false });
    }
  });

  it('imports node:http, node:https, node:dns, node:net or node:tls in client.ts and in no other file under src/', () => {
    const importers = filesUnder(srcDir)
      .filter((file) => NETWORK_IMPORT.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map(rel);
    expect(importers).toEqual([AI_CLIENT]);
  });

  it('has assertLocalAiUrl( on the line immediately above its one request call', () => {
    const sites = requestSites(fs.readFileSync(path.join(root, AI_CLIENT), 'utf8'));
    expect(sites).toHaveLength(1);
    for (const site of sites) expect(site.previous).toContain('assertLocalAiUrl(');
    // And no other file in the tree makes a request call at all.
    const others = aiFiles
      .filter((file) => rel(file) !== AI_CLIENT && requestSites(stripComments(fs.readFileSync(file, 'utf8'))).length > 0)
      .map(rel);
    expect(others).toEqual([]);
  });

  it('carries no Authorization or Cookie header, and no Bearer', () => {
    for (const file of aiFiles) {
      const bad = AI_CREDENTIAL.test(stripComments(fs.readFileSync(file, 'utf8')));
      expect({ file: rel(file), bad }).toEqual({ file: rel(file), bad: false });
    }
  });

  it('logs nothing from a prompt, an answer or a row', () => {
    for (const file of aiFiles) {
      const offending = codeLines(fs.readFileSync(file, 'utf8'))
        .filter(({ line }) => AI_CONSOLE_LEAK.test(line))
        .map(({ line }) => line.trim());
      expect({ file: rel(file), offending }).toEqual({ file: rel(file), offending: [] });
    }
  });

  it('no client component value-imports a server-only AI module', () => {
    for (const file of filesUnder(srcDir)) {
      const source = fs.readFileSync(file, 'utf8');
      if (!isClientComponent(file, source)) continue;
      const offending = source
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => AI_SERVER_ONLY.test(line) && !/^import\s+type\b/.test(line));
      expect({ file: rel(file), offending }).toEqual({ file: rel(file), offending: [] });
    }
  });

  it('the pure AI modules import no server-only AI module', () => {
    for (const name of ['lan.ts', 'schemas.ts', 'prompts.ts', 'types.ts']) {
      expect(fs.readFileSync(path.join(aiDir, name), 'utf8')).not.toMatch(AI_SERVER_ONLY);
    }
  });

  it('the scheduler reaches the queue, never the network file', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/scheduler.ts'), 'utf8');
    expect(source).toMatch(/from\s+['"]@\/lib\/ai\/queue['"]/);
    expect(source).not.toMatch(/@\/lib\/ai\/client/);
  });

  describe('each matcher catches a broken snippet', () => {
    it('a request call with no guard above it, or a guard two lines up', () => {
      expect(requestSites('const a = 1;\nconst req = http.request(url);\n')).toEqual([{ previous: 'const a = 1;' }]);
      expect(requestSites('assertLocalAiUrl(url.href);\n\nreq = transport.request(url);')[0].previous).toBe('');
      expect(requestSites('sendRequest(x);\n// request(x)\n')).toEqual([]);
      expect(requestSites("const s = 'The server refused the request (HTTP 400).';")).toEqual([]);
      expect(requestSites("const a = 1;\nhttp['request'](url);")).toEqual([{ previous: 'const a = 1;' }]);
    });

    it('a network import, by any spelling', () => {
      for (const line of [
        "import http from 'node:http';",
        "import dns from 'dns';",
        "const n = require('net');",
        "await import('node:tls')",
        "import { lookup } from 'node:dns/promises';",
      ]) {
        expect(NETWORK_IMPORT.test(line), line).toBe(true);
      }
      expect(NETWORK_IMPORT.test("import fs from 'node:fs';")).toBe(false);
    });

    it('a URL literal, a fetch, a leaking console call, a credential and a server-only import into a client', () => {
      expect(stripComments("const u = ['http', '//x'].join(':'); // see http://x").includes('://')).toBe(false);
      expect(stripComments("const u = 'http://192.168.1.5';").includes('://')).toBe(true);
      expect(/(?<![.\w])fetch\s*\(/.test(stripComments('await fetch(url);'))).toBe(true);
      expect(AI_CONSOLE_LEAK.test("console.log('[ai] asked', prompt.user);")).toBe(true);
      expect(AI_CONSOLE_LEAK.test("console.error('[ai] job failed', job.kind, name);")).toBe(false);
      expect(AI_CREDENTIAL.test("headers['Authorization'] = 'x';")).toBe(true);
      expect(AI_SERVER_ONLY.test("import { sweepAiWork } from '@/lib/ai/queue';")).toBe(true);
      expect(AI_SERVER_ONLY.test("import type { AiSuggestionView } from '@/lib/ai/types';")).toBe(false);
      expect(isClientComponent('src/components/X.tsx', "'use client';\nimport x from 'y';")).toBe(true);
      expect(isClientComponent('src/lib/x.ts', "import x from 'y';")).toBe(false);
    });
  });
});
