import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), name), 'utf8');

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');

  it('uses the glibc bookworm-slim base in every stage', () => {
    const froms = dockerfile.match(/^FROM .+$/gm) ?? [];
    expect(froms.length).toBeGreaterThanOrEqual(3);
    for (const line of froms) {
      expect(line).toContain('node:22-bookworm-slim');
    }
    expect(dockerfile).not.toContain('alpine');
  });

  it('ships the Next standalone output', () => {
    expect(dockerfile).toContain('.next/standalone');
    expect(dockerfile).toContain('.next/static');
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
  });

  it('copies the native modules explicitly (output tracing misses .node binaries)', () => {
    expect(dockerfile).toContain('node_modules/better-sqlite3');
    expect(dockerfile).toContain('node_modules/argon2');
  });

  it('copies the drizzle migrations, which are read from the working directory at boot', () => {
    expect(dockerfile).toMatch(/COPY .*\/app\/drizzle \.\/drizzle/);
  });

  it('copies CHANGELOG.md, which Settings → About reads from the working directory', () => {
    // Without this the About panel silently degrades to "no changelog available" in the
    // container only — the exact class of bug that never shows up in dev.
    expect(dockerfile).toMatch(/COPY .*\/app\/CHANGELOG\.md \.\/CHANGELOG\.md/);
  });

  it('runs as a non-root user and declares the data volume', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('VOLUME ["/data"]');
  });

  it('has a healthcheck that hits /api/health', () => {
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/api/health');
  });

  it('binds to all interfaces via HOSTNAME=0.0.0.0 (the unreachable-container classic)', () => {
    expect(dockerfile).toContain('HOSTNAME=0.0.0.0');
  });

  it('healthchecks with node -e, not curl/wget (absent from bookworm-slim)', () => {
    const healthcheckLine = dockerfile.slice(dockerfile.indexOf('HEALTHCHECK'));
    expect(healthcheckLine).toContain('node -e');
    expect(healthcheckLine).not.toContain('curl');
    expect(healthcheckLine).not.toContain('wget');
  });

  it('keeps the compiler toolchain out of the runtime stage', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).not.toContain('g++');
    expect(runtimeStage).not.toContain('build-essential');
  });

  it('copies the OCR and PDF assets that output tracing cannot see (R1)', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).toMatch(/COPY .*\/app\/vendor \.\/vendor/);
    expect(runtimeStage).toContain('node_modules/tesseract.js ');
    expect(runtimeStage).toContain('node_modules/tesseract.js-core');
    expect(runtimeStage).toContain('node_modules/pdfjs-dist');
  });

  it('creates /data/receipts alongside the other data directories', () => {
    expect(dockerfile).toMatch(/mkdir -p \/data \/data\/backups \/data\/tmp \/data\/receipts/);
  });

  it('fails the BUILD, not production, when an asset is missing (MUST-7.9 / acceptance A3)', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).toContain('RUN OCR_ASSETS_IN_IMAGE=1 node scripts/check-ocr-assets.mjs');
    // The guard must run AFTER the COPY lines it checks, or it proves nothing.
    expect(runtimeStage.indexOf('RUN OCR_ASSETS_IN_IMAGE=1 node scripts/check-ocr-assets.mjs')).toBeGreaterThan(
      runtimeStage.indexOf('node_modules/tesseract.js-core'),
    );
  });

  it('MUST-10.1 / MUST-10.2: the deps stage strips the darwin and win32 ORT binaries', () => {
    const depsStage = dockerfile.slice(
      dockerfile.indexOf('AS deps'),
      dockerfile.indexOf('AS builder'),
    );
    expect(depsStage).toMatch(/rm -rf[\s\S]*onnxruntime-node\/bin\/napi-v6\/darwin/);
    expect(depsStage).toMatch(/onnxruntime-node\/bin\/napi-v6\/win32/);
    // linux/x64 and linux/arm64 both stay, in both architectures' images.
    expect(depsStage).not.toMatch(/napi-v6\/linux/);
  });

  it('MUST-10.3: the builder vendors the scanner assets before it builds', () => {
    const builderStage = dockerfile.slice(
      dockerfile.indexOf('AS builder'),
      dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'),
    );
    expect(builderStage).toContain('scripts/vendor-scanner-assets.mjs');
    expect(builderStage.indexOf('vendor-scanner-assets.mjs')).toBeLessThan(
      builderStage.indexOf('npm run build'),
    );
  });

  it('MUST-10.4: the runner copies the ONNX runtime and sharp', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    for (const needle of [
      'node_modules/onnxruntime-node ',
      'node_modules/onnxruntime-common ',
      'node_modules/sharp ',
      'node_modules/@img ',
    ]) {
      expect(runtimeStage).toContain(needle);
    }
  });

  it('MUST-10.4: vendor/, public/ and scripts/ are copied wholesale, so the models, the scanner and the probe arrive', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).toMatch(/COPY .*\/app\/vendor \.\/vendor/);
    expect(runtimeStage).toMatch(/COPY .*\/app\/public \.\/public/);
    expect(runtimeStage).toMatch(/COPY .*\/app\/scripts \.\/scripts/);
  });

  it('MUST-10.5 / MUST-10.9: the asset guard runs after every COPY it checks, with the strip assertion on', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    const guard = runtimeStage.indexOf('node scripts/check-ocr-assets.mjs');
    expect(runtimeStage).toContain('OCR_ASSETS_IN_IMAGE=1 node scripts/check-ocr-assets.mjs');
    for (const needle of ['node_modules/tesseract.js-core', 'node_modules/onnxruntime-node ', 'node_modules/sharp ']) {
      expect(runtimeStage.indexOf(needle)).toBeLessThan(guard);
    }
  });

  it('MUST-5.14: the tesseract fallback is still in the image', () => {
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtimeStage).toContain('node_modules/tesseract.js ');
    expect(runtimeStage).toContain('node_modules/tesseract.js-core');
    expect(runtimeStage).toMatch(/COPY .*\/app\/vendor \.\/vendor/);
  });

  it('MUST-17.2 / MUST-17.3: the check directive is a parser directive at the top of the file', () => {
    const firstTwo = dockerfile.split('\n').slice(0, 2).map((line) => line.trim());
    expect(firstTwo[0]).toBe('# syntax=docker/dockerfile:1');
    expect(firstTwo[1]).toBe('# check=skip=SecretsUsedInArgOrEnv');
  });

  it('MUST-17.3: the skip can never quietly start excusing a real secret in the shipped layer', () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:22-bookworm-slim AS runner'));
    expect(runtime).not.toMatch(/^ENV SECRET_KEY=/m);
    // ...and the one ENV it does excuse is still the fixed build-stage placeholder.
    expect(dockerfile).toContain('ENV SECRET_KEY=build-time-placeholder-secret-key-0123456789');
    expect(dockerfile).toMatch(/build-stage-only string, not a credential/);
  });
});

describe('.dockerignore', () => {
  const dockerignore = read('.dockerignore');

  it('does NOT exclude vendor/, which carries the offline OCR language data (MUST-7.9)', () => {
    const lines = dockerignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).not.toContain('vendor');
    expect(lines).not.toContain('vendor/');
    expect(lines).not.toContain('/vendor');
  });

  /**
   * Next 16 regression guard. Turbopack traces `output: 'standalone'` by copying the project
   * tree, not just the files output-file-tracing identified, and the Dockerfile does
   * `COPY /app/.next/standalone ./` -- so whatever survives .dockerignore reaches the SHIPPED
   * IMAGE. Measured on the 16.3.2 upgrade: .git 25 MB, plus docs/, tests/ and .superpowers/
   * all landed inside .next/standalone/ on a local build.
   *
   * .superpowers is the one that actually matters and is why this test exists: it is
   * GITIGNORED internal working notes, and this image is PUBLIC on GHCR. An exclusion someone
   * "tidies up" later would publish them silently, with a green suite.
   */
  it('excludes the build context that Next 16 standalone tracing would otherwise ship', () => {
    const lines = dockerignore.split(/\r?\n/).map((line) => line.trim());
    for (const entry of ['.superpowers', 'tests', '.git', 'docs']) {
      expect(lines).toContain(entry);
    }
  });

  /**
   * O-02 (2026-09-02 review, P1). The test ABOVE pins four entries somebody noticed in August. It
   * cannot notice a fifth, and that is the whole defect: `.dockerignore` is a denylist, `Dockerfile`
   * does `COPY . .` into the builder, and Next 16's standalone tracing then copies the tree into an
   * image that is PUBLIC on GHCR. Every new top-level directory ships by default and silently.
   *
   * So this inverts it. Enumerate what is actually in the repo root and require every entry to be
   * either ignored or explicitly declared necessary. A new directory now FAILS the suite until
   * somebody classifies it, which is the only version of this guard that keeps working without
   * anybody remembering it exists.
   */
  const REQUIRED_IN_BUILD_CONTEXT = new Set([
    'src',
    'public',
    'drizzle',
    'scripts',
    'vendor',
    'package.json',
    'package-lock.json',
    'next.config.ts',
    'tsconfig.json',
    'postcss.config.mjs',
    'next-env.d.ts',
    // Settings -> About reads this at runtime; Dockerfile:76 copies it explicitly.
    'CHANGELOG.md',
    // Imported as a bundled JSON module by src/lib/canadian-pack.ts. Excluding it broke the
    // v1.33.0 image build while every test stayed green -- see .dockerignore's own note.
    'packs',
    // The build's own inputs. Excluding either is meaningless (docker reads them before the
    // context is assembled) but leaving them unclassified would fail this test for no reason.
    'Dockerfile',
    '.dockerignore',
    // Shipped deliberately: this image is public, and an image with no licence text is worse
    // than a few hundred wasted bytes.
    'LICENSE',
  ]);

  /** Entries git itself never sees, so they cannot be classified in advance by a human reading the repo. */
  const NEVER_IN_A_CLEAN_CHECKOUT = /^(node_modules|\.next|\.git|coverage|\.tmp-data|data)$/;

  function ignoredByDockerignore(entry: string): boolean {
    return dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .some((pattern) => {
        const bare = pattern.replace(/\/$/, '');
        if (bare === entry) return true;
        // The only glob shape this file uses, e.g. `*.db`, `*.tsbuildinfo`, `screen-*.mp4`.
        if (pattern.includes('*')) {
          const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
          return rx.test(entry);
        }
        return false;
      });
  }

  it('O-02: every top-level entry is either ignored or explicitly required', () => {
    /**
     * Top-level entries GIT tracks, not whatever happens to be on disk.
     *
     * readdirSync was the first cut and it was flaky: this suite runs in parallel with tests that
     * create temp databases and restore directories in the repo root, so the sweep failed on
     * somebody else's debris. Tracked files are the honest subject anyway — the defect this guard
     * exists to catch is a NEW DIRECTORY somebody adds and forgets to classify, and adding one
     * means committing it.
     */
    const tracked = new Set(
      execFileSync('git', ['ls-files'], { cwd: process.cwd(), encoding: 'utf8' })
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => line.split('/')[0]),
    );

    const unclassified = [...tracked]
      .filter((entry) => !NEVER_IN_A_CLEAN_CHECKOUT.test(entry))
      .filter((entry) => !REQUIRED_IN_BUILD_CONTEXT.has(entry))
      .filter((entry) => !ignoredByDockerignore(entry));

    // The message names the offender, because the person who added a directory six months from now
    // is not the person reading this test, and "add it to .dockerignore or to the allowlist" is the
    // whole decision they need to make.
    expect(
      unclassified,
      `Unclassified top-level entries. Add each to .dockerignore, or to REQUIRED_IN_BUILD_CONTEXT ` +
        `if the image genuinely needs it: ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The guard that would have caught the v1.33.0 build failure. O-02's sweep proved every
   * top-level entry was CLASSIFIED; it could not tell a correct classification from a wrong one,
   * and `packs/` was wrongly excluded on the strength of a review note. `next build` runs only in
   * the release workflow, so the mistake reached a tag.
   *
   * This reads the imports rather than trusting prose: any relative import that climbs out of src/
   * names a directory the build genuinely needs, and excluding it is a build failure by
   * construction.
   */
  it('O-02: no directory that source code imports from is excluded', () => {
    const sourceDirs = ['src'];
    const imported = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          for (const match of fs.readFileSync(full, 'utf8').matchAll(/from '((?:\.\.\/)+[^']+)'/g)) {
            const resolved = path.relative(process.cwd(), path.resolve(dir, match[1]));
            const top = resolved.split(path.sep)[0];
            if (top && top !== '..' && !top.startsWith('.')) imported.add(top);
          }
        }
      }
    };
    for (const dir of sourceDirs) walk(path.join(process.cwd(), dir));

    for (const top of imported) {
      expect(
        ignoredByDockerignore(top),
        `${top} is imported by source code but excluded from the Docker build context — next build will fail inside the image`,
      ).toBe(false);
    }
  });

  it('O-02: the entries the review found unlisted are now ignored', () => {
    // Named individually rather than trusting the sweep above, so a careless widening of the
    // allowlist cannot quietly re-admit them. `UI Component/` is a third-party design prototype
    // and `.claude` is local agent configuration -- neither belongs in a public image.
    for (const entry of ['UI Component', '.claude', '.vscode', 'fixtures', 'tsconfig.tsbuildinfo']) {
      expect(ignoredByDockerignore(entry), `${entry} is not excluded from the build context`).toBe(true);
    }
  });

  it('still admits everything the image genuinely needs', () => {
    // The mirror of the test above: over-excluding is the other way to break the image, and
    // it fails at RUN time (a missing asset, a 500) rather than at build time.
    const lines = dockerignore.split(/\r?\n/).map((line) => line.trim());
    for (const needed of ['src', 'public', 'drizzle', 'scripts', 'vendor', 'CHANGELOG.md', 'package.json']) {
      expect(lines).not.toContain(needed);
    }
  });
});

describe('image-level smoke test (v1.32.0, lane L5)', () => {
  // The standalone smoke test (scripts/smoke-test.mjs, v1.31.0) boots .next/standalone/server.js
  // directly on the host and can never catch a missing Dockerfile COPY, a read-only-rootfs
  // violation, or a file the image forgot -- it never runs the shipped image. These checks are
  // mechanical guards on the scripts and workflow that close that gap, not a restatement of the
  // brief in prose: constraints.md is explicit that "a prose enumeration is not a mechanism."

  it('adds an image-smoke npm script beside "smoke", and touches no other script line', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['smoke:image']).toBe('node scripts/smoke-test-image.mjs');
    expect(pkg.scripts.smoke).toBe('node scripts/smoke-test.mjs');
  });

  it('both smoke scripts import the route list from one shared module instead of each defining it', () => {
    const standalone = read('scripts/smoke-test.mjs');
    const image = read('scripts/smoke-test-image.mjs');
    const shared = read('scripts/smoke-routes.mjs');
    for (const listName of ['DEFAULT_PAGES', 'SPECIAL_PAGES', 'API_GETS', 'POST_ONLY_ROUTES']) {
      // Defined exactly once, in the shared module...
      const definitions = shared.match(new RegExp(`export const ${listName}\\s*=`, 'g')) ?? [];
      expect(definitions.length, `${listName} must be defined exactly once in smoke-routes.mjs`).toBe(1);
      // ...and neither consumer re-declares its own copy.
      expect(standalone).not.toMatch(new RegExp(`const ${listName}\\s*=\\s*\\[`));
      expect(image).not.toMatch(new RegExp(`const ${listName}\\s*=\\s*\\[`));
    }
    // Both actually import from the shared file rather than happening to agree today.
    expect(standalone).toMatch(/from ['"]\.\/smoke-(routes|checks)\.mjs['"]/);
    expect(image).toMatch(/from ['"]\.\/smoke-(routes|checks)\.mjs['"]/);
  });

  it('never mounts, reads, copies or references .tmp-data (the household\'s real financial data)', () => {
    for (const file of [
      'scripts/smoke-test-image.mjs',
      'scripts/smoke-seed.mjs',
      'scripts/smoke-checks.mjs',
      'scripts/smoke-fixtures.mjs',
      'scripts/smoke-routes.mjs',
      '.github/workflows/release-image.yml',
    ]) {
      expect(read(file)).not.toContain('.tmp-data');
    }
  });

  it('runs /data as a tmpfs, never a host bind mount', () => {
    const src = read('scripts/smoke-test-image.mjs');
    expect(src).toMatch(/--tmpfs['"]?,\s*['"]\/data:/);
    expect(src).not.toMatch(/-v['"]|--volume|--mount/);
  });

  it('runs the container read-only, so a rootfs write the image relies on fails here first', () => {
    expect(read('scripts/smoke-test-image.mjs')).toMatch(/--read-only/);
  });

  it('waits on the container\'s own HEALTHCHECK rather than a fixed sleep', () => {
    const src = read('scripts/smoke-test-image.mjs');
    expect(src).toMatch(/\.State\.Health/);
    expect(src).toMatch(/healthy/);
  });

  it('tears the container down on every exit path via a single process-exit hook', () => {
    const src = read('scripts/smoke-test-image.mjs');
    expect(src).toMatch(/process\.on\(['"]exit['"]/);
    expect(src).toMatch(/docker['"],\s*\[['"]rm['"]/);
    // The signal handlers must feed the same exit path, not bypass it with their own cleanup.
    expect(src).toMatch(/process\.on\(['"]SIGINT['"]/);
    expect(src).toMatch(/process\.on\(['"]SIGTERM['"]/);
  });

  it('degrades honestly with no Docker: a clear SKIP, never a silent no-op, never a false pass', () => {
    const src = read('scripts/smoke-test-image.mjs');
    expect(src).toMatch(/SKIP/);
    expect(src).toMatch(/not a PASS/i);
    // The skip path must not run the request battery and report a hollow "0/0 passed" as if it
    // had exercised anything -- reviewed guards that asserted an empty list with no positive
    // control are exactly the shape this must not repeat.
    const skipBranch = src.slice(src.indexOf('if (!docker.ok)'), src.indexOf('} else {'));
    expect(skipBranch).not.toMatch(/runPageChecks|runApiChecks/);
  });

  it('release-image.yml builds and smoke-tests the image before it is ever pushed to GHCR', () => {
    const workflow = read('.github/workflows/release-image.yml');
    const smokeStepIdx = workflow.indexOf('npm run smoke:image');
    const loadIdx = workflow.indexOf('load: true');
    const pushIdx = workflow.indexOf('push: true');
    expect(smokeStepIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    // The image that gets smoked is loaded locally BEFORE the smoke step runs, and the smoke
    // step itself runs strictly before the step that pushes to GHCR.
    expect(loadIdx).toBeLessThan(smokeStepIdx);
    expect(smokeStepIdx).toBeLessThan(pushIdx);
  });
});

describe('version and changelog', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string; dependencies: Record<string, string> };
  const changelog = read('CHANGELOG.md');

  it('keeps package.json and the newest changelog section on the same version', () => {
    const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
    expect(newest, 'CHANGELOG.md has no dated version section').toBeTruthy();
    expect(pkg.version).toBe(newest![1]);
  });

  it('declares the three new runtime dependencies (§17.27)', () => {
    for (const name of ['tesseract.js', 'pdfjs-dist', 'tar']) {
      expect(pkg.dependencies[name], `missing dependency ${name}`).toBeTruthy();
    }
  });

  it('has a dated 1.2.3 section and a fresh empty Unreleased above it', () => {
    expect(changelog).toContain('## [1.2.3] - 2026-08-17');
    expect(changelog).toContain('## [1.2.2] - 2026-08-17');
    expect(changelog).toContain('## [1.2.1] - 2026-08-17');
    expect(changelog).toContain('## [1.2.0] - 2026-08-17');
    const unreleased = changelog.indexOf('## Unreleased');
    const released123 = changelog.indexOf('## [1.2.3]');
    const released122 = changelog.indexOf('## [1.2.2]');
    const released121 = changelog.indexOf('## [1.2.1]');
    const released120 = changelog.indexOf('## [1.2.0]');
    expect(unreleased).toBeGreaterThan(-1);
    expect(unreleased).toBeLessThan(released123);
    expect(released123).toBeLessThan(released122);
    expect(released122).toBeLessThan(released121);
    expect(released121).toBeLessThan(released120);
    // Unreleased must be empty going into 1.2.3 — nothing this session wrote should still be
    // sitting above the new dated section.
    expect(changelog.slice(unreleased, released123)).not.toContain('Watchtower auto-update');
    // The previously-unreleased 1.2.2 entry was ABSORBED into its own dated section, not left
    // sitting in Unreleased — same invariant carried forward for each prior release in turn.
    expect(changelog.slice(unreleased, released123)).not.toContain('Contract and loan item kinds');
    expect(changelog.slice(unreleased, released123)).not.toContain('Prebuilt multi-arch images');
    // §17.23's original absorption invariant, restored alongside each release added since: whatever
    // was absorbed into 1.2.0 at THAT release must not still be sitting in Unreleased either.
    expect(changelog.slice(unreleased, released120)).not.toContain('Forced password change');
  });

  it('records the backup format change in 1.1.0', () => {
    const section = changelog.slice(changelog.indexOf('## [1.1.0]'), changelog.indexOf('## [1.0.0]'));
    expect(section).toContain('tar.gz');
    expect(section).toMatch(/older `?\.db`? backups still restore|still restore/i);
    expect(section).toContain('Warranty');
  });

  it('MUST-7.1: the 1.34.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.34.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.34\.0\] - 2026-09-08$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.34.0]'));
    expect(changelog.indexOf('## [1.34.0]')).toBeLessThan(changelog.indexOf('## [1.33.0]'));
    const release = changelog.slice(changelog.indexOf('## [1.34.0]'), changelog.indexOf('## [1.33.0]'));
    // This release DOES carry a migration, and saying so is what tells a household to take a
    // backup first -- the opposite of every recent release's "No migration".
    expect(release).toMatch(/Migration 0022/i);
    // The defect that cost a whole release: a green suite and a broken image.
    expect(release).toMatch(/never\s+published\s+an\s+image/i);
    expect(release).toMatch(/packs\//);
    // The two behaviours the owner asked for, in the words he used for them.
    expect(release).toMatch(/only\s+when\s+transactions\s+have\s+actually\s+arrived/i);
    expect(release).toMatch(/waits\s+until\s+you\s+say\s+the\s+month\s+is\s+complete/i);
    // The quiet account is the case that broke every inference-based rule; it must stay named.
    expect(release).toMatch(/quiet\s+one\s+with\s+nothing\s+to\s+import/i);
  });

  it('MUST-7.1: the 1.33.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.34.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.33\.0\] - 2026-09-08$/m);
    expect(changelog.indexOf('## [1.33.0]')).toBeLessThan(changelog.indexOf('## [1.32.0]'));
    const release = changelog.slice(changelog.indexOf('## [1.33.0]'), changelog.indexOf('## [1.32.0]'));
    // No schema change, as every release says when it is true.
    expect(release).toMatch(/No migration/i);
    // The release's headline: the owner's actual complaint, and the shape that replaced it.
    expect(release).toMatch(/not\s+a\s+message\s+each/i);
    expect(release).toMatch(/\$180\s+of\s+\$100,\s+\$80\s+over/);
    // The float that reached a phone.
    expect(release).toMatch(/98\.61999999999999/);
    // The three safety properties, each of which is invisible until the day it matters.
    expect(release).toMatch(/verified\s+backup\s+before\s+every\s+upgrade/i);
    expect(release).toMatch(/refuses\s+to\s+start\s+against\s+a\s+database\s+written\s+by\s+a\s+newer\s+version/i);
    expect(release).toMatch(/crash\s+checkpoints\s+the\s+database/i);
    // The button that did nothing, in the words the owner used for it.
    expect(release).toMatch(/now\s+sends/i);
    // A restart must never again produce a wall of alerts.
    expect(release).toMatch(/restart\s+no\s+longer\s+fires\s+a\s+burst/i);
  });

  it('MUST-7.1: the 1.32.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.32\.0\] - 2026-09-08$/m);
    expect(changelog.indexOf('## [1.32.0]')).toBeLessThan(changelog.indexOf('## [1.31.0]'));
    const release = changelog.slice(changelog.indexOf('## [1.32.0]'), changelog.indexOf('## [1.31.0]'));
    // Seven efforts, no schema change -- the same promise every release makes, and what lets a
    // self-hosted household skip the pre-pull database review.
    expect(release).toMatch(/No migration/i);
    // The release's headline defect, in the words a household would use for it: a channel they had
    // deliberately configured produced nothing, and the reason was invisible from the settings
    // screen that configured it. \s+ because the file is hard-wrapped.
    expect(release).toMatch(/family\s+channel\s+stayed\s+quiet/i);
    expect(release).toMatch(/subscriber\s+in\s+its\s+own\s+right/i);
    // ...and the invariant the fix must never lose while fixing it. A second copy of every routed
    // message is the failure mode that would look like the feature working.
    expect(release).toMatch(/Nothing\s+is\s+sent\s+twice/i);
    // The two owner-facing additions.
    expect(release).toMatch(/Send\s+a\s+spending\s+summary\s+now/i);
    expect(release).toMatch(/Expanding\s+a\s+category\s+in\s+the\s+review\s+view/i);
    // The navigation defect behind the second one: the symptom, not the mechanism, because the
    // mechanism may be rewritten and the symptom must never come back.
    expect(release).toMatch(/one-way\s+door/i);
    // The restart screen's own lie, which is the kind of thing a refactor quietly reintroduces by
    // routing a planned restart back through the ordinary crash boundary.
    expect(release).toMatch(/restart\s+screen\s+said\s+the\s+app\s+had\s+crashed/i);
    // 1.31.0 deferred the warranty consolidation to this release by name; recording that it landed
    // is what stops it being deferred a second time.
    expect(release).toMatch(/three\s+copies\s+are\s+gone/i);
  });

  it('MUST-7.1: the 1.31.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.31\.0\] - 2026-09-04$/m);
    expect(changelog.indexOf('## [1.31.0]')).toBeLessThan(changelog.indexOf('## [1.30.0]'));
    const release = changelog.slice(changelog.indexOf('## [1.31.0]'), changelog.indexOf('## [1.30.0]'));
    // Ten features and twenty-five fixes ship with no schema change, and saying so is what lets a
    // self-hosted household skip the pre-pull database review.
    expect(release).toMatch(/No migration/i);
    // The release's four headline additions, in the words a household would use for them. Each is
    // a capability somebody would notice missing if a later refactor dropped it.
    expect(release).toMatch(/links to the rows behind it/i);
    expect(release).toMatch(/Income by source/i);
    expect(release).toMatch(/Which devices are signed in as me/i);
    // The Recurring card's honesty is the invariant, not the card: it must never assert a
    // subscription it cannot evidence, and a fix round was needed because the badge did exactly
    // that from a two-gap median. \s+ because the file is hard-wrapped.
    expect(release).toMatch(/rhythm\s+is\s+not\s+a\s+subscription/i);
    // The two defects whose user-visible symptom must never be reintroduced: a destructive action
    // that under-reported what it would touch, and a label fight that made a row read differently
    // on different days.
    expect(release).toMatch(/stranded\s+rows/i);
    expect(release).toMatch(/fought\s+over\s+the\s+same\s+row/i);
    // The build gate this release added. Nothing in CI had ever started the application before it.
    expect(release).toMatch(/boots\s+the\s+application\s+and\s+requests\s+every\s+route/i);
  });

  it('MUST-7.1: the 1.30.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.30\.0\] - 2026-09-03$/m);
    expect(changelog.indexOf('## [1.30.0]')).toBeLessThan(changelog.indexOf('## [1.29.1]'));
    const entry = changelog.slice(changelog.indexOf('## [1.30.0]'), changelog.indexOf('## [1.29.1]'));
    // A defect-only release ships no schema change, and saying so is what lets a self-hosted
    // household skip the pre-pull database review entirely.
    expect(entry).toMatch(/No migration/i);
    // The two halves of the release's headline security fix, neither of which may be lost: a
    // self-scoped member could READ another member's rows, and the answer is an empty list rather
    // than their own spending shown under somebody else's name. \s+ because the file is hard-wrapped.
    expect(entry).toMatch(/could\s+read\s+anyone's\s+transactions/i);
    expect(entry).toMatch(/relabelled\s+under\s+another\s+person's\s+name/i);
    // The notification fix is only correct if it withheld the leak WITHOUT silencing the shared
    // room -- the first implementation did exactly that, so the changelog records the distinction.
    expect(entry).toMatch(/family\s+channel\s+still\s+receives/i);
    // The update card's two symptoms, in the words a household would use for them.
    expect(entry).toMatch(/Update\s+now/);
    expect(entry).toMatch(/refused\s+by\s+the\s+server/i);
    // Same promise this project makes on every defect release: the bugs were visibility and
    // arithmetic, never data loss.
    expect(entry).toMatch(/Nothing\s+was\s+saved,\s+changed\s+or\s+lost/i);
  });

  it('MUST-7.1: the 1.29.1 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.29\.1\] - 2026-09-01$/m);
    expect(changelog.indexOf('## [1.29.1]')).toBeLessThan(changelog.indexOf('## [1.29.0]'));
    const patch = changelog.slice(changelog.indexOf('## [1.29.1]'), changelog.indexOf('## [1.29.0]'));
    // A patch whose whole reason for existing is a page that would not load must say so plainly,
    // and must say that nothing was lost -- that is the question a household actually has when a
    // settings page has been erroring. \s+ because the file is hard-wrapped.
    expect(patch).toMatch(/would\s+not\s+load/i);
    expect(patch).toMatch(/Nothing\s+was\s+saved,\s+changed\s+or\s+lost/i);
  });

  it('MUST-7.1: the 1.29.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.29\.0\] - 2026-09-01$/m);
    expect(changelog.indexOf('## [1.29.0]')).toBeLessThan(changelog.indexOf('## [1.28.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.29.0]'), changelog.indexOf('## [1.28.0]'));
    // Every release that ships a schema change names it; this one ships none, and saying so is
    // what lets a self-hosted household skip the pre-pull database review entirely.
    expect(entry).toMatch(/No migration/i);
    // The invariant behind the tabs: each one is a real address, not a client-side panel toggle --
    // so it can be bookmarked and the back button works. No \s+ needed: this one is inside a
    // backticked code span, which the prose wrapper never breaks across a line.
    expect(entry).toMatch(/\?tab=telegram/);
    // The two halves of the runway fix that must never be lost: the divisor follows the household's
    // real history, and an interior quiet month is real signal rather than missing data.
    expect(entry).toMatch(/months\s+you\s+actually\s+have/i);
    expect(entry).toMatch(/quiet\s+month\s+in\s+the\s+middle/i);
  });

  it('MUST-7.1: the 1.28.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.28\.0\] - 2026-09-01$/m);
    expect(changelog.indexOf('## [1.28.0]')).toBeLessThan(changelog.indexOf('## [1.27.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.28.0]'), changelog.indexOf('## [1.27.0]'));
    expect(entry).toMatch(/One migration \(0021\)/i);
    // The invariants this release must never lose: a routed event REPLACES the personal copy, and
    // a security event can never reach a shared room. \s+ because the file is hard-wrapped.
    expect(entry).toMatch(/instead\s+of/i);
    expect(entry).toMatch(/can\s+never\s+be\s+sent\s+to\s+a\s+family\s+channel/i);
  });

  it('MUST-7.1: the 1.27.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.27\.0\] - 2026-09-01$/m);
    expect(changelog.indexOf('## [1.27.0]')).toBeLessThan(changelog.indexOf('## [1.26.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.27.0]'), changelog.indexOf('## [1.26.0]'));
    // \s+ not a literal space: this file is hard-wrapped, so an asserted phrase can land across a
    // line break plus indentation.
    expect(entry).toMatch(/One migration \(0020\)/i);
    // The invariant this release must never lose: a loan assignment is a statement about one
    // transaction, never about the merchant.
    expect(entry).toMatch(/no\s+longer\s+teaches\s+a\s+rule/i);
  });

  it('MUST-7.1: the 1.26.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.26\.0\] - 2026-09-01$/m);
    expect(changelog.indexOf('## [1.26.0]')).toBeLessThan(changelog.indexOf('## [1.25.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.26.0]'), changelog.indexOf('## [1.25.0]'));
    // An unannounced schema change is the one thing a self-hosted household cannot review before
    // pulling the image, so the migration this release ships must be named in its own entry.
    expect(entry).toMatch(/One migration \(0019\)/i);
    // The invariant behind the whole release: rule-assigned rows never reach Needs review, so the
    // entry must say the audit surface exists and that it blocks nothing.
    // \s+ not a literal space: this file is hard-wrapped at ~100 columns, so any phrase asserted
    // here can land across a line break plus indentation. A literal-space regex would make the
    // guard depend on where the prose happens to wrap, which is not what it is guarding.
    expect(entry).toMatch(/never\s+appear in Needs review/i);
    expect(entry).toMatch(/split-aware/i);
  });

  it('MUST-7.1: the 1.25.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.25\.0\] - 2026-09-01$/m);
    expect(changelog.indexOf('## [1.25.0]')).toBeLessThan(changelog.indexOf('## [1.24.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.25.0]'), changelog.indexOf('## [1.24.0]'));
    // The migration this release ships must be NAMED in its own entry -- an unannounced schema
    // change is the one thing a self-hosted household cannot review before pulling the image.
    expect(entry).toMatch(/One migration \(0018\)/i);
    // The three invariants this release must never lose: whole-word matching exists because a
    // brand name inside a longer word was misfiling money, a successful restore must never be
    // reported as failed, and a replaced pack rule must not be silently restored.
    expect(entry).toMatch(/METROLINX/);
    expect(entry).toMatch(/successful restore could be reported as FAILED/i);
    expect(entry).toMatch(/not added back/i);
  });

  it('MUST-7.1: the 1.24.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.24\.0\] - 2026-09-01$/m);
    expect(changelog.indexOf('## [1.24.0]')).toBeLessThan(changelog.indexOf('## [1.23.1]'));
    const entry = changelog.slice(changelog.indexOf('## [1.24.0]'), changelog.indexOf('## [1.23.1]'));
    expect(entry).toMatch(/No migration/i);
    // The three invariants this release must never lose: clearing a rule is not an undo, a rename
    // revert is never date-bounded, and "transfers only" is a route back to a mis-flagged row.
    expect(entry).toMatch(/cannot be undone/i);
    expect(entry).toMatch(/Bounding a rename revert/i);
    expect(entry).toMatch(/Transfers only/);
  });

  it('MUST-7.1: the 1.23.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    // 1.23.1 is a presentation-only patch on top of 1.23.0; both entries must stay present.
    expect(changelog).toMatch(/^## \[1\.23\.1\] - 2026-08-31$/m);
    expect(changelog).toMatch(/^## \[1\.23\.0\] - 2026-08-31$/m);
    expect(changelog.indexOf('## [1.23.1]')).toBeLessThan(changelog.indexOf('## [1.23.0]'));
    expect(changelog.indexOf('## [1.23.0]')).toBeLessThan(changelog.indexOf('## [1.22.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.23.0]'), changelog.indexOf('## [1.22.0]'));
    expect(entry).toMatch(/Install the preset rules from inside the app/i);
    expect(entry).toMatch(/One migration \(0017\)/i);
    // The invariant that release must never lose: an update is announced, never applied.
    expect(entry).toMatch(/Nothing is ever applied on its own/i);
  });

  it('MUST-7.1: the 1.22.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.22\.0\] - 2026-08-31$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.22.0]'));
    expect(changelog.indexOf('## [1.22.0]')).toBeLessThan(changelog.indexOf('## [1.21.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.22.0]'), changelog.indexOf('## [1.21.0]'));
    expect(entry).toMatch(/A Canadian merchant rules pack/i);
    expect(entry).toMatch(/Rule packs can carry merchant renames/i);
    expect(entry).toMatch(/No migration/i);
  });

  it('MUST-7.1: the 1.21.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.21\.0\] - 2026-08-31$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.21.0]'));
    expect(changelog.indexOf('## [1.21.0]')).toBeLessThan(changelog.indexOf('## [1.20.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.21.0]'), changelog.indexOf('## [1.20.0]'));
    // The three things this release is about: money classified by what it did, one meaning for
    // "in this category", and merchant rules becoming manageable.
    expect(entry).toMatch(/Lending money out is no longer counted as spending it/i);
    expect(entry).toMatch(/A parent category's own spending has a row/i);
    expect(entry).toMatch(/Merchant rules have their own page/i);
    // Unlike 1.19/1.20 this release DOES carry a migration; the entry must say so.
    expect(entry).toMatch(/One migration \(0016\)/i);
  });

  it('MUST-7.1: the 1.20.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.20\.0\] - 2026-08-30$/m);
    expect(changelog.indexOf('## [1.20.0]')).toBeLessThan(changelog.indexOf('## [1.19.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.20.0]'), changelog.indexOf('## [1.19.0]'));
    expect(entry).toMatch(/No migration/i);
    // The three things this release is actually about, each phrased the way the entry states it:
    // one card renderer instead of two, one dialog for every row editor instead of two idioms,
    // and creation forms behind a button on every page rather than five Settings holdouts.
    expect(entry).toMatch(/One card renders a transaction everywhere/i);
    expect(entry).toMatch(/Every row editor is the same dialog/i);
    expect(entry).toMatch(/behind a button, on every page that creates something/i);
  });

  it('MUST-7.1: the 1.19.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.19\.0\] - 2026-08-30$/m);
    expect(changelog.indexOf('## [1.19.0]')).toBeLessThan(changelog.indexOf('## [1.18.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.19.0]'), changelog.indexOf('## [1.18.0]'));
    expect(entry).toMatch(/No migration/i);
    expect(entry).toMatch(/one set of components/i);
    expect(entry).toMatch(/Accept all suggestions/);
  });

  it('MUST-7.1: the 1.18.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.18.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.18\.0\] - 2026-08-30$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.18.0]'));
    expect(changelog.indexOf('## [1.18.0]')).toBeLessThan(changelog.indexOf('## [1.17.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.18.0]'), changelog.indexOf('## [1.17.0]'));
    // 1.17.0 carried migration 0015, so "no migration" is the contrast a reader coming straight
    // off that release needs, not boilerplate.
    expect(entry).toMatch(/No migration/i);
    expect(entry).toMatch(/outgrown/i);
    expect(entry).toMatch(/month is stated once/i);
  });

  it('MUST-7.1: the 1.17.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.17.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.17\.0\] - 2026-08-30$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.17.0]'));
    expect(changelog.indexOf('## [1.17.0]')).toBeLessThan(changelog.indexOf('## [1.16.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.17.0]'), changelog.indexOf('## [1.16.0]'));
    // The FIRST release since 1.14.0 that carries a migration. The previous three all said "No
    // migration", so a reader who has learned to skim that line has to be stopped by this one.
    expect(entry).toMatch(/migration \(0015\)/i);
    expect(entry).toMatch(/additive/i);
    expect(entry).toMatch(/savings target/i);
    expect(entry).toMatch(/transfers excluded/i);
  });

  it('MUST-7.1: the 1.16.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.16.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.16\.0\] - 2026-08-30$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.16.0]'));
    expect(changelog.indexOf('## [1.16.0]')).toBeLessThan(changelog.indexOf('## [1.15.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.16.0]'), changelog.indexOf('## [1.15.0]'));
    // The new card reads loan_payments and bill_installments, both of which already carry the
    // index it needs. Saying so is what tells a reader they do not have to back up first.
    expect(entry).toMatch(/No migration/i);
    expect(entry).toMatch(/Linked transactions/);
    expect(entry).toMatch(/No end date/);
  });

  it('MUST-7.1: the 1.15.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.15.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.15\.0\] - 2026-08-29$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.15.0]'));
    expect(changelog.indexOf('## [1.15.0]')).toBeLessThan(changelog.indexOf('## [1.14.2]'));
    const entry = changelog.slice(changelog.indexOf('## [1.15.0]'), changelog.indexOf('## [1.14.2]'));
    // A reader on 1.14.2 is deciding whether to back up first. Saying there is no migration is the
    // information, and this release genuinely touches nothing but markup and one stylesheet.
    expect(entry).toMatch(/No migration/i);
    expect(entry).toMatch(/cards on a phone/i);
    expect(entry).toMatch(/Quick add/);
    expect(entry).toMatch(/uncategorized/);
  });

  it('MUST-7.1: the 1.14.2 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.14.2');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.14\.2\] - 2026-08-29$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.14.2]'));
    expect(changelog.indexOf('## [1.14.2]')).toBeLessThan(changelog.indexOf('## [1.14.1]'));
    const entry = changelog.slice(changelog.indexOf('## [1.14.2]'), changelog.indexOf('## [1.14.1]'));
    expect(entry).toMatch(/No migration/i);
    expect(entry).toMatch(/Assign to loan/);
    expect(entry).toMatch(/group children under their parent/i);
  });

  it('MUST-7.1: the 1.14.1 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.14.1');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.14\.1\] - 2026-08-29$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.14.1]'));
    expect(changelog.indexOf('## [1.14.1]')).toBeLessThan(changelog.indexOf('## [1.14.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.14.1]'), changelog.indexOf('## [1.14.0]'));
    // A reader coming from 1.14.0 has just been told to back up for a migration. Saying there is
    // none this time is the information.
    expect(entry).toMatch(/No migration/i);
    expect(entry).toMatch(/review=1/);
    expect(entry).toMatch(/still teaches the categorizer|still teaches|teaches the categorizer/i);
    expect(entry).toMatch(/Not a transfer/);
  });

  it('MUST-7.1: the 1.14.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.14.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.14\.0\] - 2026-08-28$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.14.0]'));
    expect(changelog.indexOf('## [1.14.0]')).toBeLessThan(changelog.indexOf('## [1.13.3]'));
    const entry = changelog.slice(changelog.indexOf('## [1.14.0]'), changelog.indexOf('## [1.13.3]'));
    expect(entry).toMatch(/### Added/);
    expect(entry).toMatch(/### Changed/);
    expect(entry).toMatch(/### Fixed/);
    // Unlike the last three releases, this one DOES change the schema. A reader coming from
    // 1.13.3 must be told to take a backup, and must not find the "no migration" line here.
    expect(entry).not.toMatch(/no migration/i);
    expect(entry).toMatch(/Before updating/);
    expect(entry).toMatch(/all-or-nothing/i);
    expect(entry).toMatch(/roll back/i);
    // The headline claims, asserted as claims and not just as a version number.
    expect(entry).toMatch(/Lent out — they owe us/);
    expect(entry).toMatch(/Who owes us/);
    expect(entry).toMatch(/net worth/i);
    expect(entry).toMatch(/Review page/);
  });

  it('MUST-7.1: the 1.13.3 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.13.3');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.13\.3\] - 2026-08-28$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.13.3]'));
    expect(changelog.indexOf('## [1.13.3]')).toBeLessThan(changelog.indexOf('## [1.13.2]'));
    const entry = changelog.slice(changelog.indexOf('## [1.13.3]'), changelog.indexOf('## [1.13.2]'));
    expect(entry).toMatch(/no migration/i);
    expect(entry).toMatch(/Test-only/);
  });

  it('MUST-7.1: the 1.13.2 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.13.2');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.13\.2\] - 2026-08-28$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.13.2]'));
    expect(changelog.indexOf('## [1.13.2]')).toBeLessThan(changelog.indexOf('## [1.13.1]'));
    const entry = changelog.slice(changelog.indexOf('## [1.13.2]'), changelog.indexOf('## [1.13.1]'));
    expect(entry).toMatch(/### Fixed/);
    expect(entry).toMatch(/no migration/i);
    expect(entry).toMatch(/each child under its own parent/i);
  });

  it('MUST-7.1: the 1.13.1 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.13.1');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.13\.1\] - 2026-08-28$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.13.1]'));
    const entry = changelog.slice(changelog.indexOf('## [1.13.1]'), changelog.indexOf('## [1.13.0]'));
    expect(entry).toMatch(/### Fixed/);
    expect(entry).toMatch(/### Security/);
    expect(entry).toMatch(/### Changed/);
    // A reader coming from 1.13.0 is expecting a schema warning. Saying there is none is the
    // information; omitting the paragraph is not.
    expect(entry).toMatch(/changes no tables at all/i);
    // The headline claims, asserted as claims and not just as a version number.
    expect(entry).toMatch(/Check now/);
    expect(entry).toMatch(/Sign-in\s+column/);
    expect(entry).toMatch(/next due date, or an\s+overdue count/i);
    expect(entry).toMatch(/\+N more due/);
    expect(entry).toMatch(/no ownership check at all/i);
    expect(entry).toMatch(/skipped rather than sent household-wide/i);
    expect(entry).toMatch(/no longer carry the household roster/i);
  });

  it('MUST-7.1: the 1.13.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.13.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.13\.0\] - 2026-08-27$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.13.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.13.0]'), changelog.indexOf('## [1.12.'));
    expect(entry).toMatch(/### Added/);
    expect(entry).toMatch(/### Changed/);
    // The headline claims, asserted as claims and not just as a version number.
    expect(entry).toMatch(/Only their own records/);
    expect(entry).toMatch(/Needs a look/);
    expect(entry).toMatch(/OFX/);
    expect(entry).toMatch(/Record payment/);
    expect(entry).toMatch(/audit/i);
    // A release that changes who may delete what has to say so, or somebody upgrades into a refusal.
    expect(entry).toMatch(/require you to own it/i);
    // The three presets are unverified and the release notes must not imply otherwise.
    expect(entry).toMatch(/have not yet been checked against a real file/i);
  });

  it('MUST-7.1: the 1.12.1 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.12.1');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.12\.1\] - 2026-08-27$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.12.1]'));
    const entry = changelog.slice(changelog.indexOf('## [1.12.1]'), changelog.indexOf('## [1.12.0]'));
    expect(entry).toMatch(/### Fixed/);
    expect(entry).toMatch(/### Security/);
    // A release that touches the schema must say so BEFORE the list of what changed, or the reader
    // finds out after they have already pulled. \s+ throughout because the sentences wrap.
    expect(entry).toMatch(/\*\*Before updating:\*\*/);
    expect(entry).toMatch(/does not rebuild either of them/i);
    // The headline claims, asserted as claims and not just as a version number: an entry that
    // bumped the version without saying what a reader will see is the gap this guard is for.
    expect(entry).toMatch(/sub-categories are counted again/i);
    expect(entry).toMatch(/pay a bill and a loan/i);
    expect(entry).toMatch(/Un-marking a bill installment sticks/i);
    // A release fixing silent failures has to say what the app does INSTEAD, or "it fails
    // silently" is replaced by "it is fixed" and neither tells a person anything.
    expect(entry).toMatch(/Could not save/);
    expect(entry).toMatch(/treated as\s+"no change"/i);
    // Every security change is a claim about what an attacker can no longer do.
    expect(entry).toMatch(/signs out every other session/i);
    expect(entry).toMatch(/can only be used once/i);
    expect(entry).toMatch(/no longer trusts a header the client controls/i);
  });

  it('MUST-7.1: the 1.12.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.12.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.12\.0\] - 2026-08-24$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.12.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.12.0]'), changelog.indexOf('## [1.11.0]'));
    expect(entry).toMatch(/### Added/);
    expect(entry).toMatch(/### Changed/);
    // The headline claims, asserted as claims and not just as a version number: an entry that
    // bumped the version without saying what a reader will see is the gap this guard is for.
    expect(entry).toMatch(/Bills with due dates/i);
    expect(entry).toMatch(/Installments/);
    // A release that adds reminders must say what happens when one is missed, or "it reminds you"
    // reads as "nothing can slip".
    expect(entry).toMatch(/overdue/i);
    // The reversal of a shipped behaviour has to be stated, not merely done -- somebody liked it.
    expect(entry).toMatch(/start collapsed/i);
    // \s+ because the sentence wraps in the file.
    expect(entry).toMatch(/un-marks the installments\s+that import paid/i);
  });

  it('MUST-7.1: the 1.11.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.11.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.11\.0\] - 2026-08-24$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.11.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.11.0]'), changelog.indexOf('## [1.10.3]'));
    expect(entry).toMatch(/### Changed/);
    // The two headline claims, asserted as claims and not just as a version number: an entry
    // that bumped the version without saying what a reader will see is the gap this guard is
    // for.
    expect(entry).toMatch(/save themselves/i);
    // A save that can be refused must document what happens on refusal, or "it saves itself"
    // reads as "it always works".
    expect(entry).toMatch(/goes back to its previous\s+value/i);
    expect(entry).toMatch(/cut off|clipped/i);
  });

  it('MUST-7.1: the 1.10.3 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.10.3');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.10\.3\] - 2026-08-24$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.10.3]'));
    const patch = changelog.slice(changelog.indexOf('## [1.10.3]'), changelog.indexOf('## [1.10.2]'));
    expect(patch).toMatch(/### Fixed/);
    // A release that fixes a regression of OUR OWN making must say so, and say which version
    // introduced it, so someone on that version knows the update is not optional.
    expect(patch).toMatch(/regression introduced in 1\.10\.1/i);
    expect(patch).toMatch(/phone/i);
    // The claim 1.10.1 made and could not keep. Naming it here is the correction.
    expect(patch).toMatch(/scroll/i);
  });

  it('MUST-7.1: the 1.10.2 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.10.2');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.10\.2\] - 2026-08-24$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.10.2]'));
    const patch = changelog.slice(changelog.indexOf('## [1.10.2]'), changelog.indexOf('## [1.10.1]'));
    expect(patch).toMatch(/### Fixed/);
    expect(patch).toMatch(/### Changed/);
    // The two reported defects and the rule that came out of them, one claim each.
    expect(patch).toMatch(/Serial number/);
    expect(patch).toMatch(/Save warranty/);
    expect(patch).toMatch(/type is now fixed once it has been saved/i);
    // Freezing the type removes a control, so the entry must say how to recover from a wrong
    // one. A restriction documented without its escape hatch reads as a dead end.
    // \s+ because the sentence wraps in the file -- a literal-space regex passes or fails on
    // where the paragraph happened to break, which is not what is being asserted.
    expect(patch).toMatch(/delete the\s+item and add it again/i);
    // ...and must say that an existing value is never hidden, which is the guarantee the
    // value-preserving gate exists to make.
    expect(patch).toMatch(/nothing you saved earlier can be erased/i);
  });

  it('MUST-7.1: the 1.10.1 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.10.1');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.10\.1\] - 2026-08-24$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.10.1]'));
    const patch = changelog.slice(changelog.indexOf('## [1.10.1]'), changelog.indexOf('## [1.10.0]'));
    expect(patch).toMatch(/### Fixed/);
    // A layout-only release must say so. A reader who thought a column of figures had been
    // recomputed would go hunting for a change that was never made.
    expect(patch).toMatch(/layout only/i);
    // The three surfaces this release actually touched, one claim each.
    expect(patch).toMatch(/Roll over unspent/);
    expect(patch).toMatch(/import history/i);
    expect(patch).toMatch(/CSV preview/i);
    // Ruling: nothing may be hidden to make a table fit. The guard for it lives in
    // tests/ops/table-layout.test.ts; this asserts the release described it honestly rather
    // than claiming a fit it achieved by clipping.
    expect(patch).toMatch(/scrolls sideways rather\s+than hiding anything/);
  });

  it('MUST-7.1: the 1.10.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.10.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.10\.0\] - 2026-08-23$/m);
    // An empty Unreleased section is left in place for the next session.
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.10.0]'));
    const patch = changelog.slice(changelog.indexOf('## [1.10.0]'), changelog.indexOf('## [1.9.0]'));
    expect(patch).toMatch(/### Added/);
    expect(patch).toMatch(/### Fixed/);
    // The release's own headline claims, one per surface, so a section that quietly loses one
    // fails here rather than shipping a changelog that undersells what an install gained.
    expect(patch).toMatch(/Help/);
    expect(patch).toMatch(/getting-started card/i);
    expect(patch).toMatch(/What is this page for\?/);
    // A documentation release must SAY it moves no money. A reader who thought their balances
    // had been recomputed would go looking for a difference that is not there -- the same
    // reasoning that made 1.9.0 state it changed nothing about the running app.
    expect(patch).toMatch(/No financial calculation changed/i);
    expect(patch).toMatch(/no database migration/i);
    // Ruling A2: the help page must not dispense financial advice, and the changelog must not
    // imply it does. This is the one claim in the release that would be a product change
    // rather than a documentation change if it were ever true.
    expect(patch).not.toMatch(/how much you should (spend|save)/i);
    // The README correction is a privacy claim, so it has to be recorded as one rather than
    // filed as a typo: the old wording overstated what a sharing pack reveals.
    expect(patch).toMatch(/sharing packs/i);
    expect(read('README.md')).not.toMatch(/redacted slice/);
  });

  it('MUST-7.1: the 1.9.0 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.9.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.9\.0\] - 2026-08-23$/m);
    // An empty Unreleased section is left in place for the next session.
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.9.0]'));
    const patch = changelog.slice(changelog.indexOf('## [1.9.0]'), changelog.indexOf('## [1.8.1]'));
    // A toolchain-only release must SAY it changes nothing about the running app. A changelog
    // entry that let a reader think their install gained a feature would be worse than none.
    expect(patch).toMatch(/### Changed/);
    expect(patch).toMatch(/Next\.js 16/);
    expect(patch).toMatch(/React 19\.2/);
    // The runtime move of the auth filter is the one behavioural change in this release, and
    // the entry must say it was verified against a real production build rather than implying
    // a green suite was the evidence -- a green suite is exactly what missed the v1.5.1 500.
    expect(patch).toMatch(/Node runtime/i);
    expect(patch).toMatch(/production build/i);
    // The devDependency and the note must move together -- a claim about 6.0.3 with the pin
    // still on 5.x is exactly the two-places-one-bump bug MUST-7.1 exists to catch.
    const pkgFull = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkgFull.devDependencies.typescript).toMatch(/^\^?6\./);
    expect(pkgFull.dependencies.next).toMatch(/^\^?16\./);
    expect(pkgFull.dependencies.react).toMatch(/^\^?19\.[2-9]/);
    // Same discipline for the two advisory bumps this release claims: a Security note naming
    // versions the manifest does not actually pin is the two-places-one-bump bug wearing a
    // security label, which is worse than the plain kind because it reads as reassurance.
    expect(patch).toMatch(/### Security/);
    expect(pkgFull.dependencies['drizzle-orm']).toMatch(/^\^?0\.45\./);
    expect(pkgFull.dependencies['node-cron']).toMatch(/^\^?4\./);
  });

  it('MUST-7.1: the 1.8.1 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.8.1');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.8\.0\] - 2026-08-23$/m);
    const section = changelog.slice(changelog.indexOf('## [1.8.0]'), changelog.indexOf('## [1.7.0]'));
    // The release's own headline claims. One per feature, so a section that quietly loses one
    // of them fails here rather than shipping a changelog that undersells or overstates.
    expect(section).toMatch(/balance column|running balance/i);
    expect(section).toMatch(/owe/i);
    expect(section).toMatch(/### Fixed/);
    expect(section).toMatch(/Coming up/i);
    expect(section).toMatch(/dropdown/i);
    expect(section).toMatch(/scanner/i);
    // Ruling R7: the reconciliation copy must promise reporting only. A changelog that claimed
    // this feature fixes anything for you would be describing software that does not exist.
    expect(section).toMatch(/only reports|nothing is adjusted/i);
  });

  it('MUST-7.1: the 1.7.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.7\.0\] - 2026-08-23$/m);
    const section = changelog.slice(changelog.indexOf('## [1.7.0]'), changelog.indexOf('## [1.6.0]'));
    expect(section).toMatch(/split/i);
    expect(section).toMatch(/net worth/i);
    expect(section).toMatch(/roll/i);
    expect(section).toMatch(/tax/i);
    expect(section).toMatch(/paid off/i);
    expect(section).toMatch(/install/i);
    // The two genuinely pre-existing fixes are called out as such, since everything else the
    // review found was in code written for this release and never reached a running install.
    expect(section).toContain('### Fixed');
    expect(section).toMatch(/predate this release/i);
  });

  it('MUST-7.1: the 1.6.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.6\.0\] - 2026-08-22$/m);
    const section = changelog.slice(changelog.indexOf('## [1.6.0]'), changelog.indexOf('## [1.5.1]'));
    expect(section).toMatch(/cardholder/i);
    expect(section).toMatch(/deactivat/i);
    expect(section).toContain('Settings -> Accounts');
    expect(section).not.toMatch(/PP-OCR|ONNX|tesseract/i);
  });

  it('MUST-3.14: README names the model provenance and no fourth egress destination', () => {
    const readme = read('README.md');
    for (const needle of ['PP-OCRv5', 'RapidOCR', 'PaddleOCR', 'Baidu', 'Apache-2.0']) {
      expect(readme).toContain(needle);
    }
    expect(readme).not.toContain('modelscope');
  });

  it('risk R10: INSTALL documents the one recovery the automatic check cannot do', () => {
    expect(read('INSTALL.md')).toContain('ocr.engine');
  });

  it('MUST-8.3 / MUST-18.5: the docs name the third egress exception and the two new variables', () => {
    for (const doc of ['README.md', 'INSTALL.md']) {
      const source = read(doc);
      expect(source).toContain('api.github.com');
      expect(source).toContain('WATCHTOWER_URL');
      expect(source).toContain('WATCHTOWER_TOKEN');
    }
    const example = read('.env.example');
    expect(example).toMatch(/^# WATCHTOWER_URL=/m);
    expect(example).toMatch(/^# WATCHTOWER_TOKEN=/m);
  });
});

describe('docker-compose.yml', () => {
  const compose = read('docker-compose.yml');

  it('mounts /data and keeps the root filesystem read-only', () => {
    expect(compose).toContain('/data');
    expect(compose).toMatch(/read_only:\s*true/);
  });

  it('mounts a tmpfs at /tmp because the Node runtime needs a tmpdir', () => {
    expect(compose).toContain('tmpfs:');
    expect(compose).toContain('/tmp');
  });

  it('drops all capabilities and forbids privilege escalation', () => {
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('no-new-privileges:true');
  });

  it('does not require SECRET_KEY — it is optional, zero-config by default', () => {
    expect(compose).not.toMatch(/SECRET_KEY:\s*\$\{SECRET_KEY:\?/);
    expect(compose).toMatch(/SECRET_KEY:\s*\$\{SECRET_KEY:-\}/);
  });

  it('defines a healthcheck', () => {
    expect(compose).toContain('healthcheck:');
    expect(compose).toContain('/api/health');
  });

  it('healthchecks with node -e, not curl/wget (absent from bookworm-slim)', () => {
    const healthcheckBlock = compose.slice(compose.indexOf('healthcheck:'));
    expect(healthcheckBlock).toContain('node');
    expect(healthcheckBlock).not.toContain('curl');
    expect(healthcheckBlock).not.toContain('wget');
  });
});

describe('README.md', () => {
  const readme = read('README.md');

  it('documents both install paths, with PC-build first', () => {
    expect(readme).toContain('docker save');
    expect(readme).toContain('docker load');
    expect(readme.indexOf('docker save')).toBeLessThan(readme.indexOf('Building on the NAS'));
  });

  it('documents SECRET_KEY generation and the loss consequence', () => {
    expect(readme).toContain('randomBytes');
    expect(readme).toMatch(/re-?enroll/i);
  });

  it('documents the restore procedure including the -wal and -shm files', () => {
    expect(readme).toContain('-wal');
    expect(readme).toContain('-shm');
  });

  it('recommends HTTPS and states the plain-HTTP caveat honestly', () => {
    expect(readme).toContain('Tailscale');
    expect(readme).toMatch(/reverse proxy/i);
    expect(readme).toMatch(/WPA2|wifi password|Wi-Fi password/i);
  });

  it('mentions the TRUST_PROXY switch', () => {
    expect(readme).toContain('TRUST_PROXY');
  });

  it('documents the warranty tracker and its offline OCR', () => {
    expect(readme).toMatch(/warrant/i);
    expect(readme).toMatch(/OCR/);
    expect(readme).toMatch(/offline|no internet|LAN-only/i);
  });
});
