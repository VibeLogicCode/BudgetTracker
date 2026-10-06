import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Vitest transpiles TSX itself (Oxc under Vite 8); force the automatic runtime here rather
  // than inherit whatever jsx mode Next leaves in tsconfig.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': path.resolve(rootDir, 'src') },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
    // better-sqlite3 is a native addon: forks (not worker threads) keep it stable. Vitest 4
    // dropped poolOptions; one fork per file in parallel is its default.
    pool: 'forks',
    env: {
      SECRET_KEY: 'test-secret-key-0123456789-abcdefghijklmnop',
      TZ: 'America/Toronto',
      DATA_DIR: path.resolve(rootDir, '.tmp-data'),
    },
    testTimeout: 20000,
    hookTimeout: 20000,
    // Defence, not a fix for anything known: every current vi.spyOn(fs, ...) site already
    // restores itself (mockRestore in a finally, or an explicit .mockRestore() call). This
    // just stops a future unrestored spy from leaking into an unrelated test in this
    // shared-process pool (`pool: 'forks'`).
    restoreMocks: true,
    // Vitest 4 narrowed restoreMocks to vi.spyOn descriptors only. Under Vitest 3 it also
    // cleared every mock's call history and put each vi.fn(impl) back to impl before every
    // test, and tests that read mock.calls[0] of a module-scoped mock depend on that.
    // mockReset is the Vitest 4 switch for that half.
    mockReset: true,
  },
});
