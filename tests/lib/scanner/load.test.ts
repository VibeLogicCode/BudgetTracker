// @vitest-environment jsdom
//
// B5: load.ts's runtime-init gate read `if (typeof cv.onRuntimeInitialized === 'undefined') {
// resolve(); return; }`. Emscripten leaves that property undefined until code assigns to it,
// so the condition was always true, and loadScanner() resolved before the wasm runtime existed
// -- B1 masked this (every call failed anyway), but fixing B1 alone would have left a race: the
// first pick after every page load would usually lose a ~7MB wasm compile on a phone.
//
// This drives the real loadScanner()/load() against a controllable fake `cv` and asserts it
// only proceeds -- and only resolves -- once the fake's `.then()` callback actually fires,
// proving the gate now genuinely waits on the runtime instead of checking a property that is
// never set. jsdom does not execute injected <script src> tags, so script "loading" is
// simulated by recording the elements load.ts creates and firing their onload ourselves once
// we have set the global each script would really have defined.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCANNER_LOAD_TIMEOUT_MS } from '@/lib/warranty/ocr/onnx/constants';

let scripts: HTMLScriptElement[] = [];
let restore: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  scripts = [];
  const original = document.createElement.bind(document) as (
    tagName: string,
    options?: ElementCreationOptions,
  ) => HTMLElement;
  const spy = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const element = original(tagName, options);
      if (tagName === 'script') scripts.push(element as HTMLScriptElement);
      return element;
    }) as typeof document.createElement);
  restore = () => spy.mockRestore();
  delete (window as unknown as { cv?: unknown }).cv;
  delete (window as unknown as { jscanify?: unknown }).jscanify;
});

afterEach(() => {
  restore?.();
  vi.restoreAllMocks();
});

describe('B5: loadScanner waits for the wasm runtime, not a synthetic gate', () => {
  it('blocks on jscanify.min.js, and on resolving, until the cv thenable actually fires', async () => {
    const { loadScanner } = await import('@/lib/scanner/load');

    // BLOCKER fix: the real bundle's `then` invokes its callback WITH the module object
    // itself (`func(Module)`), never with no argument -- a fake that calls `onfulfilled()`
    // conforms to the type load.ts used to declare (no `value` parameter) rather than to the
    // real contract, and that mismatch is exactly what hid the `await cv` hang: this fake
    // must hand back `fakeCv` itself, the same self-referential shape the real bundle does.
    let runtimeReady: ((value: unknown) => void) | undefined;
    const fakeCv = {
      then: vi.fn((onfulfilled: (value: unknown) => void) => {
        runtimeReady = onfulfilled;
      }),
    };
    class FakeJscanify {}

    const resultPromise = loadScanner();

    // Synchronous up to here: load() ran until its first real `await` (injectScript's
    // Promise), which had already created and appended the opencv.js <script>.
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toContain('/scanner/opencv.js');

    (window as unknown as { cv: unknown }).cv = fakeCv;
    scripts[0].onload?.(new Event('load'));

    // Let load() resume past `await injectScript(...)` and reach the point where it calls
    // `cv.then(...)` (never `await cv` directly -- see the BLOCKER fix in load.ts).
    await vi.waitFor(() => expect(fakeCv.then).toHaveBeenCalledTimes(1));
    // The OLD gate never called `.then` at all: it resolved as soon as it read
    // `typeof cv.onRuntimeInitialized`, which is always 'undefined'. Reaching this line at
    // all is already proof the fixed code awaits the thenable instead of that property.
    expect(runtimeReady).toBeDefined();

    // It must still be BLOCKED: jscanify.min.js must not load, and loadScanner()'s own promise
    // must not resolve, until the callback we were just handed is actually invoked.
    expect(scripts).toHaveLength(1);
    const settledEarly = await Promise.race([
      resultPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(settledEarly).toBe('pending');

    // Now let the runtime "finish initialising" -- handed `fakeCv` itself, exactly as the
    // real bundle's `func(Module)` would, proving the fix does not hang on a self-referential
    // resolution value.
    runtimeReady?.(fakeCv);
    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    expect(scripts[1].src).toContain('/scanner/jscanify.min.js');

    (window as unknown as { jscanify: unknown }).jscanify = FakeJscanify;
    scripts[1].onload?.(new Event('load'));

    const result = await resultPromise;
    expect(result.cv).toBe(fakeCv);
    expect(result.scanner).toBeInstanceOf(FakeJscanify);
  });

  it('resolves promptly when the runtime is already initialised (the fast path)', async () => {
    const { loadScanner } = await import('@/lib/scanner/load');

    // Same fix as above: the real bundle's fast path (`calledRun` already true) calls
    // `func(Module)` synchronously and immediately -- with the module itself, not nothing.
    const fakeCv: { then: (onfulfilled: (value: unknown) => void) => void } = {
      then: vi.fn((onfulfilled: (value: unknown) => void) => onfulfilled(fakeCv)),
    };
    class FakeJscanify {}

    const resultPromise = loadScanner();
    (window as unknown as { cv: unknown }).cv = fakeCv;
    scripts[0].onload?.(new Event('load'));

    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    (window as unknown as { jscanify: unknown }).jscanify = FakeJscanify;
    scripts[1].onload?.(new Event('load'));

    const result = await resultPromise;
    expect(result.cv).toBe(fakeCv);
    expect(result.scanner).toBeInstanceOf(FakeJscanify);
  });
});

describe('BLOCKER: `await cv` adopts the self-referential thenable and hangs forever', () => {
  it('consults the cv thenable exactly once, never re-adopting the value it resolves with', async () => {
    const { loadScanner } = await import('@/lib/scanner/load');

    // A bounded stand-in for the real bug: the shipping bundle's `then` always resolves with
    // `Module` itself (a faithful replication of it, driven the same way as here, produced
    // 2,000,000+ recursive `then()` calls with no bound at all -- see the scratchpad
    // reproduction this test's bound is modelled on). This fake caps that at BOUND turns so
    // a regression can never hang this suite: past the bound it resolves with `undefined`
    // instead, which is the one thing a genuinely infinite chain would never do on its own.
    // The assertion below does not depend on the bound being generous -- `await cv` fails it
    // by recursing at all (more than once), and the fix passes it by construction (exactly
    // once), regardless of where the bound is set.
    const BOUND = 5;
    let thenCalls = 0;
    const fakeCv: { then: (onfulfilled: (value: unknown) => void) => void } = {
      then: vi.fn((onfulfilled: (value: unknown) => void) => {
        thenCalls += 1;
        onfulfilled(thenCalls <= BOUND ? fakeCv : undefined);
      }),
    };
    class FakeJscanify {}

    const resultPromise = loadScanner();
    (window as unknown as { cv: unknown }).cv = fakeCv;
    scripts[0].onload?.(new Event('load'));

    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    (window as unknown as { jscanify: unknown }).jscanify = FakeJscanify;
    scripts[1].onload?.(new Event('load'));

    await resultPromise;

    // The fix (`cv.then(() => resolve())`) never hands the value `cv.then` resolves with to
    // anything the JS engine would re-check for thenability, so nothing re-adopts `fakeCv`
    // and `.then` is consulted exactly once. `await cv` directly would instead let the
    // engine's own PromiseResolveThenableJob machinery keep unwrapping the self-referential
    // value on every one of the BOUND turns above before this fake gave up -- this is what
    // fails against `await cv` and passes only against the fix.
    expect(thenCalls).toBe(1);
  });
});

// F5 (v1.8.0): loadScanner() clears its module-level `cached` promise on a
// SCANNER_LOAD_TIMEOUT_MS timeout, but the timeout only loses loadScanner's own
// Promise.race -- it cancels nothing, and the original load() call keeps running in the
// background. Before this fix, the next photo pick called load() again, which (a)
// re-assigned window.Module, potentially breaking the still-initialising first instance's
// locateFile hook so its .wasm 404s, and (b) injected /scanner/opencv.js a second time with
// no guard for an existing tag or an existing window.cv -- a second Emscripten runtime and a
// second ~9 MB wasm heap, on the exact slow/low-memory phone that caused the timeout. These
// tests drive two overlapping loadScanner() calls against the same fake script-tag machinery
// the B5/BLOCKER suites above use, and pin that the injection is memoized per src rather than
// re-run.
describe('F5: opencv.js injection is memoized across a timeout and a retry', () => {
  afterEach(() => {
    // Scoped in addition to the file's global afterEach: vi.restoreAllMocks() (used there)
    // does not touch fake-timer state, and leaving fake timers active would bleed into
    // whichever test runs next.
    vi.useRealTimers();
  });

  it('injects each script exactly once across a timeout and a retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { loadScanner } = await import('@/lib/scanner/load');

    const first = loadScanner();
    expect(scripts).toHaveLength(1);

    vi.advanceTimersByTime(SCANNER_LOAD_TIMEOUT_MS + 1);
    await expect(first).rejects.toThrow(/timed out/);

    // The timeout only lost loadScanner's Promise.race -- it cancelled nothing, so the
    // original load() (and its one <script> tag) is still out there, still awaiting an
    // onload that never came. The retry must attach to it, not append a second tag.
    void loadScanner().catch(() => {});
    expect(scripts.filter((element) => element.src.includes('/scanner/opencv.js'))).toHaveLength(1);
  });

  it('does not re-assign window.Module on a retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { loadScanner } = await import('@/lib/scanner/load');

    const first = loadScanner();
    // The first instance resolves its .wasm through this exact hook while still compiling
    // (see load.ts's own comment on why the hook is set before injection). Capture its
    // identity, not just its shape, so a retry that swaps in an equivalent-looking
    // replacement object still fails this assertion.
    const firstModule = (window as unknown as { Module?: unknown }).Module;
    expect(firstModule).toBeDefined();

    vi.advanceTimersByTime(SCANNER_LOAD_TIMEOUT_MS + 1);
    await expect(first).rejects.toThrow(/timed out/);

    void loadScanner().catch(() => {});
    expect((window as unknown as { Module?: unknown }).Module).toBe(firstModule);
  });

  it('short-circuits when window.cv is already present', async () => {
    const { loadScanner } = await import('@/lib/scanner/load');

    // Models the first load() (orphaned by an earlier timeout, per the tests above) having
    // gone on to finish setting window.cv in the background before this call happens.
    const fakeCv: { then: (onfulfilled: (value: unknown) => void) => void } = {
      then: vi.fn((onfulfilled: (value: unknown) => void) => onfulfilled(fakeCv)),
    };
    class FakeJscanify {}
    (window as unknown as { cv: unknown }).cv = fakeCv;

    const resultPromise = loadScanner();

    // No opencv.js <script> at all: window.cv already existed, so injecting it again would
    // just re-run the bundle and stand up a second Emscripten runtime for no reason. jscanify
    // still has to load -- window.cv existing says nothing about window.jscanify.
    expect(scripts.filter((element) => element.src.includes('/scanner/opencv.js'))).toHaveLength(0);
    await vi.waitFor(() => expect(scripts).toHaveLength(1));
    expect(scripts[0].src).toContain('/scanner/jscanify.min.js');

    (window as unknown as { jscanify: unknown }).jscanify = FakeJscanify;
    scripts[0].onload?.(new Event('load'));

    const result = await resultPromise;
    expect(result.cv).toBe(fakeCv);
    expect(result.scanner).toBeInstanceOf(FakeJscanify);
  });

  it('resolves the retry from the original in-flight load once it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { loadScanner } = await import('@/lib/scanner/load');

    const first = loadScanner();
    vi.advanceTimersByTime(SCANNER_LOAD_TIMEOUT_MS + 1);
    await expect(first).rejects.toThrow(/timed out/);

    // The point: a slow phone's retry attaches to the still-compiling first instance instead
    // of hanging on a fresh attempt that never gets its own script tag.
    const retry = loadScanner();

    const fakeCv: { then: (onfulfilled: (value: unknown) => void) => void } = {
      then: vi.fn((onfulfilled: (value: unknown) => void) => onfulfilled(fakeCv)),
    };
    class FakeJscanify {}

    expect(scripts).toHaveLength(1);
    (window as unknown as { cv: unknown }).cv = fakeCv;
    scripts[0].onload?.(new Event('load'));

    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    (window as unknown as { jscanify: unknown }).jscanify = FakeJscanify;
    scripts[1].onload?.(new Event('load'));

    const result = await retry;
    expect(result.cv).toBe(fakeCv);
    expect(result.scanner).toBeInstanceOf(FakeJscanify);
  });

  it('re-injects after a genuine load ERROR, unlike after a timeout', async () => {
    const { loadScanner } = await import('@/lib/scanner/load');

    const first = loadScanner();
    expect(scripts).toHaveLength(1);
    scripts[0].onerror?.(new Event('error'));
    await expect(first).rejects.toThrow(/could not load/);

    // Unlike a timeout, an onerror means the script will never arrive -- the retry must be a
    // genuinely fresh attempt, with its own new <script> tag, not an attachment to a load
    // that has already failed for good.
    void loadScanner().catch(() => {});
    expect(scripts.filter((element) => element.src.includes('/scanner/opencv.js'))).toHaveLength(2);
  });
});
