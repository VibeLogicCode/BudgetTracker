import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Review D6. Every exported async function in a `'use server'` module is a POST endpoint, whether
 * or not a <form> is bound to it: Next's action runtime will call it from any page that can reach
 * the site, and a plain RPC called from client code is the same endpoint as one behind a form.
 *
 * Two of them -- previewRuleClearAction and previewRerunAllAction -- had no same-origin check at
 * all, and the review found them by reading. This guard finds the next one.
 *
 * The check may be named directly or reached through a local helper this file knows about, because
 * several modules wrap "origin, then admin" in one line and inlining it would be worse.
 */
const ACTION_ROOT = 'src/app';
const DIRECT = ['isSameOrigin(', 'assertSameOrigin('];

function serverActionFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      serverActionFiles(full, found);
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    const source = fs.readFileSync(full, 'utf8');
    if (/^\s*['"]use server['"]/m.test(source.split('\n').slice(0, 3).join('\n'))) {
      found.push(full.replace(/\\/g, '/'));
    }
  }
  return found;
}

/**
 * Each exported async function's body, by brace matching from its opening `{`. A regex cannot do
 * this: an action body is full of nested braces, and the next `export` is not always the end.
 */
function exportedActions(source: string): { name: string; body: string }[] {
  return functionsIn(source, /export\s+async\s+function\s+(\w+)\s*\(/g);
}

/**
 * The file's OWN helpers that perform the check, resolved rather than hard-coded by name. Several
 * modules wrap "origin, then admin" in one line -- settings/actions.ts calls it updateGuard, the
 * notifications module calls it guard -- and inlining the check into thirteen bodies to satisfy a
 * text scan would be worse code. Resolving them means a helper that stops checking fails this
 * guard, which a name allow-list would not.
 */
function localGuards(source: string): string[] {
  return functionsIn(source, /(?:async\s+)?function\s+(\w+)\s*\(/g)
    .filter((fn) => DIRECT.some((name) => fn.body.includes(name)))
    .map((fn) => fn.name + '(');
}

/**
 * The body's opening brace, which is NOT simply the next `{`: an action's parameter list is very
 * often an inline object type (`input: { scope: BudgetScope; ... }`) and its return type is
 * usually `Promise<{ rows: X } | { error: string }>`. Taking the first brace read the TYPE as the
 * body and reported two already-guarded actions as unguarded -- a guard that cries wolf gets
 * disabled, so it has to be right.
 *
 * The rule: close the parameter list by paren depth, then take the first `{` outside any `<...>`
 * whose contents actually read like code.
 */
function bodyBrace(source: string, from: number): number {
  let depth = 1;
  let index = from;
  for (; index < source.length && depth > 0; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') depth -= 1;
  }
  let angle = 0;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === '<') angle += 1;
    else if (char === '>') angle = Math.max(0, angle - 1);
    else if (char === '{' && angle === 0) {
      const closing = matchingBrace(source, index);
      const candidate = source.slice(index, closing + 1);
      if (/\b(return|await|const|if|for|throw)\b/.test(candidate)) return index;
      index = closing;
    }
  }
  return -1;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

function functionsIn(source: string, signature: RegExp): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = signature.exec(source)) !== null) {
    const open = bodyBrace(source, match.index + match[0].length);
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    out.push({ name: match[1]!, body: source.slice(open, end + 1) });
  }
  return out;
}

function unguarded(file: string, source: string): string[] {
  const accepted = [...DIRECT, ...localGuards(source)];
  return exportedActions(source)
    .filter((action) => !accepted.some((name) => action.body.includes(name)))
    .map((action) => `${file} :: ${action.name}`);
}

const FILES = serverActionFiles(ACTION_ROOT);

describe('D6: every server action checks the request came from this app', () => {
  /** A positive control: the walker must actually be finding actions, not an empty list. */
  it('finds the action modules and their exports', () => {
    expect(FILES.length).toBeGreaterThan(5);
    const actions = FILES.flatMap((file) => exportedActions(fs.readFileSync(file, 'utf8')));
    expect(actions.length).toBeGreaterThan(50);
    expect(actions.some((action) => action.name === 'setLimitAction')).toBe(true);
  });

  /** And a negative control: a body with no guard in it must be caught. */
  it('catches an action that skips the check', () => {
    const planted = 'export async function plantedAction(formData: FormData) {\n  return { ok: true };\n}\n';
    expect(unguarded('planted.ts', planted)).toEqual(['planted.ts :: plantedAction']);
  });

  /** The helper resolution is real: a wrapper that checks satisfies it, one that stopped does not. */
  it('accepts a local helper that checks, and rejects one that does not', () => {
    const wrapped =
      "async function guard() { if (!isSameOrigin(await headers())) return { error: 'no' }; return null; }\n" +
      'export async function wrappedAction() { const blocked = await guard(); if (blocked) return blocked; return {}; }\n';
    expect(unguarded('wrapped.ts', wrapped)).toEqual([]);
    expect(unguarded('wrapped.ts', wrapped.replace('isSameOrigin(await headers())', 'true'))).toEqual([
      'wrapped.ts :: wrappedAction',
    ]);
  });

  it('no exported action is missing it', () => {
    expect(FILES.flatMap((file) => unguarded(file, fs.readFileSync(file, 'utf8')))).toEqual([]);
  });
});
