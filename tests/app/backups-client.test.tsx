// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RestoreOutcome } from '@/lib/backup/restore';
import { BackupsClient } from '@/app/(app)/settings/backups/backups-client';

vi.mock('@/app/(app)/settings/backups/actions', () => ({
  setRetentionAction: vi.fn(async () => ({})),
  runBackupNowAction: vi.fn(async () => ({})),
  stageRestoreAction: vi.fn(async () => ({
    restarting: true,
    message: 'Restoring — the app will restart. Refresh this page in about 30 seconds.',
  })),
}));

afterEach(() => cleanup());

const backups = [
  { name: 'budget-2026-08-16.tar.gz', bytes: 4_194_304, modifiedAt: '2026-08-16T06:00:00.000Z' },
  { name: 'budget-2026-08-15.tar.gz', bytes: 4_100_000, modifiedAt: '2026-08-15T06:00:00.000Z' },
];
const noRestore = { staged: null, result: null };
/** v1.63.0: the page passes the restore upload's limits; these are the real ones. */
const limits = { maxBytes: 4 * 1024 * 1024 * 1024, chunkBytes: 8 * 1024 * 1024 };

describe('MUST-20.35: the confirm step', () => {
  it('names the backup and keeps the submit disabled until the box is ticked', () => {
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={noRestore} />);

    const row = screen.getByText('budget-2026-08-16.tar.gz').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /^restore$/i }));

    const panel = within(row);
    // Each phrase below is worded specifically enough that it cannot also match the
    // "Restore and restart" submit button rendered in the same row (which itself contains
    // the word "restart") — MUST-20.35's requirement that the panel names the backup, warns
    // that data is replaced, names the safety copy, and explains the restart.
    expect(panel.getByText(/budget-2026-08-16\.tar\.gz/)).toBeTruthy();
    expect(panel.getByText(/replaces all data currently in the app/i)).toBeTruthy();
    expect(panel.getByText(/budget\.pre-restore-/)).toBeTruthy();
    expect(panel.getByText(/restarts to apply this/i)).toBeTruthy();
    expect(panel.getByText(/no restart policy/i)).toBeTruthy();
    expect(panel.getByText(/two-factor settings and deactivations return to the backup/i)).toBeTruthy();
    expect(panel.getByText(/everyone signs in again/i)).toBeTruthy();

    const submit = panel.getByRole('button', { name: /restore and restart/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(panel.getByRole('checkbox'));
    expect(submit.disabled).toBe(false);
  });

  it('opens at most one panel at a time and Cancel collapses it', () => {
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={noRestore} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^restore$/i })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /^restore$/i })[0]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('unchecking the box after ticking it disables the submit button again', () => {
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={noRestore} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^restore$/i })[0]);
    const checkbox = screen.getByRole('checkbox');
    const submit = screen.getByRole('button', { name: /restore and restart/i }) as HTMLButtonElement;
    fireEvent.click(checkbox);
    expect(submit.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(submit.disabled).toBe(true);
  });
});

describe('MUST-20.30: the restarting notice', () => {
  it('replaces the page after a successful submit and leaves nothing to click', async () => {
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={noRestore} />);

    fireEvent.click(screen.getAllByRole('button', { name: /^restore$/i })[0]);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /restore and restart/i }));

    expect(await screen.findByText(/refresh this page in about 30 seconds/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the staged-but-not-yet-applied notice and disables Restore buttons', () => {
    render(
      <BackupsClient
        backups={backups}
        retention={14} upload={limits}
        restore={{
          staged: {
            version: 1,
            payload: 'payload',
            sourceName: 'budget-2026-08-16.tar.gz',
            kind: 'archive',
            bytes: 4_194_304,
            sha256: '0'.repeat(64),
            appliedMigrations: 4,
            requestedByUserId: 3,
            requestedByUsername: 'meena',
            requestedAt: '2026-08-16T21:04:11.482Z',
            appVersion: '1.1.0',
          },
          result: null,
        }}
      />,
    );
    expect(screen.getByText(/a restore is staged and will be applied the next time the app starts/i)).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: /^restore$/i })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('MUST-20.35: the result banner', () => {
  it('renders a success outcome', () => {
    const result: RestoreOutcome = {
      version: 1,
      status: 'success',
      sourceName: 'budget-2026-08-16.tar.gz',
      kind: 'archive',
      requestedByUserId: 3,
      requestedByUsername: 'meena',
      requestedAt: '2026-08-16T21:04:11.482Z',
      finishedAt: '2026-08-16T21:04:53.106Z',
      safetyCopy: 'budget.pre-restore-2026-08-16T21-04-49-772Z.db',
      receiptsMovedAside: 'receipts.pre-restore-2026-08-16T21-04-49-772Z',
      receiptsRestored: 128,
      missingReceiptRows: 0,
      receiptsTouched: 0,
      error: null,
    };
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={{ staged: null, result }} />);
    expect(screen.getByText(/Restored budget-2026-08-16\.tar\.gz/)).toBeTruthy();
    expect(screen.getByText(/128 receipt files/)).toBeTruthy();
    expect(screen.getByText(/budget\.pre-restore-2026-08-16T21-04-49-772Z\.db/)).toBeTruthy();
    expect(screen.getByText(/are as they were in that backup, and everyone signs in again/i)).toBeTruthy();
  });

  it('renders a failure outcome verbatim', () => {
    const result = {
      version: 1,
      status: 'failed',
      sourceName: 'budget-2026-08-16.tar.gz',
      kind: 'archive',
      requestedByUserId: 3,
      requestedByUsername: 'meena',
      requestedAt: '2026-08-16T21:04:11.482Z',
      finishedAt: '2026-08-16T21:04:53.106Z',
      safetyCopy: null,
      receiptsMovedAside: null,
      receiptsRestored: 0,
      missingReceiptRows: 0,
      receiptsTouched: 0,
      error: 'The archive contains no budget.db.',
    } satisfies RestoreOutcome;
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={{ staged: null, result }} />);
    expect(screen.getByText('The archive contains no budget.db.')).toBeTruthy();
  });
});

/** v1.60.0 item 7d: the page names why the last nightly backup failed. */
describe('the last backup failure', () => {
  it('shows the recorded reason when the last backup failed', () => {
    render(
      <BackupsClient
        backups={backups}
        retention={14} upload={limits}
        restore={noRestore}
        health={{
          lastBackupAt: '2026-08-16T06:00:00.000Z',
          ageHours: 31,
          state: 'failed',
          failureReason: 'The new backup failed its check: zlib: unexpected end of file',
        }}
      />,
    );
    expect(screen.getByText(/The last backup failed/)).toBeTruthy();
    expect(screen.getByText(/The new backup failed its check: zlib: unexpected end of file/)).toBeTruthy();
  });

  it('says nothing about failure when the backups are healthy', () => {
    render(
      <BackupsClient
        backups={backups}
        retention={14} upload={limits}
        restore={noRestore}
        health={{ lastBackupAt: '2026-08-16T06:00:00.000Z', ageHours: 7, state: 'ok', failureReason: null }}
      />,
    );
    expect(screen.queryByText(/The last backup failed/)).toBeNull();
  });
});

/**
 * v1.63.0 C6: Restore from a file. The upload goes through XMLHttpRequest (for progress), so the
 * tests swap in a fake one that records every request and answers it on the test's terms.
 */
describe('Restore from a file', () => {
  const MIB = 1024 * 1024;
  const ID = '0b9d2c4e-7f1a-4c3b-9e8d-5a6b7c8d9e0f';
  const START = '/api/backup/restore-upload';
  const SESSION = `${START}/${ID}`;

  interface FakeRequest {
    method: string;
    url: string;
    body: unknown;
    headers: Record<string, string>;
    respond: (status: number, reply: unknown) => void;
    fail: () => void;
  }
  type Answer = [number, unknown] | 'network' | null;

  let requests: FakeRequest[] = [];
  let answer: (request: FakeRequest, index: number) => Answer = () => null;

  class FakeXhr {
    status = 0;
    responseText = '';
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private method = '';
    private url = '';
    private headers: Record<string, string> = {};

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    }

    send(body: unknown) {
      const request: FakeRequest = {
        method: this.method,
        url: this.url,
        body,
        headers: this.headers,
        respond: (status, reply) => {
          if (body instanceof Blob) this.upload.onprogress?.({ loaded: body.size });
          this.status = status;
          this.responseText = JSON.stringify(reply);
          this.onload?.();
        },
        fail: () => this.onerror?.(),
      };
      requests.push(request);
      const given = answer(request, requests.length - 1);
      if (given === 'network') setTimeout(() => request.fail(), 0);
      else if (given !== null) setTimeout(() => request.respond(given[0], given[1]), 0);
    }
  }

  const offsetOf = (request: FakeRequest) => Number(new URL(request.url, 'http://nas.local').searchParams.get('offset'));
  const sizeOf = (request: FakeRequest) => (request.body instanceof Blob ? request.body.size : 0);
  const sequence = () => requests.map((request) => `${request.method} ${request.url}`);

  function chooseFile(file: File) {
    fireEvent.change(screen.getByLabelText('Backup file to restore'), { target: { files: [file] } });
  }

  function fileOf(bytes: number, name = 'budget-2026-08-16.tar.gz'): File {
    return new File([new Uint8Array(bytes)], name);
  }

  function startUpload() {
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Upload, restore and restart' }));
  }

  const restarting = {
    restarting: true,
    message: 'Restoring uploaded: budget-2026-08-16.tar.gz. The app will restart. Refresh this page in about 30 seconds.',
  };

  beforeEach(() => {
    requests = [];
    answer = () => null;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says exactly what the row restore says, from one component', () => {
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={noRestore} />);
    const row = screen.getByText('budget-2026-08-16.tar.gz').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /^restore$/i }));
    chooseFile(fileOf(10));

    const warnings = screen.getAllByTestId('restore-warnings');
    expect(warnings).toHaveLength(2);
    expect(row.contains(warnings[0])).toBe(true);
    expect(warnings[1].textContent).toBe(warnings[0].textContent);
    expect(warnings[1].textContent).toMatch(/replaces all data currently in the app/);
    expect(warnings[1].textContent).toMatch(/everyone signs in again/);
  });

  it('names the file and its size, and needs the box ticked', () => {
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={noRestore} />);
    chooseFile(fileOf(3 * MIB));
    expect(screen.getByText('3 MB', { exact: false })).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Upload, restore and restart' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit.disabled).toBe(false);
  });

  it('refuses a file over the limit before anything is sent', () => {
    render(<BackupsClient backups={backups} retention={14} upload={{ maxBytes: 8, chunkBytes: 4 }} restore={noRestore} />);
    chooseFile(fileOf(10, 'too-big.tar.gz'));
    expect(screen.getByText(/a restore from a file takes at most/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upload, restore and restart' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('starts, sends the pieces in order at their offsets, shows progress, then finishes', async () => {
    answer = (request) => {
      if (request.method === 'POST' && request.url === START) return [200, { id: ID, chunkBytes: MIB }];
      if (request.method === 'PUT') return offsetOf(request) === MIB ? null : [200, { received: offsetOf(request) + sizeOf(request) }];
      if (request.method === 'POST' && request.url === SESSION) return [200, restarting];
      return [200, {}];
    };
    render(<BackupsClient backups={backups} retention={14} upload={{ maxBytes: 64 * MIB, chunkBytes: MIB }} restore={noRestore} />);
    chooseFile(fileOf(3 * MIB));
    startUpload();

    const held = await waitFor(() => {
      const found = requests.find((request) => request.method === 'PUT' && offsetOf(request) === MIB);
      expect(found).toBeTruthy();
      return found!;
    });
    expect(screen.getByText('Uploading 1 of 3 MB')).toBeTruthy();
    act(() => held.respond(200, { received: 2 * MIB }));

    expect(await screen.findByText(/Refresh this page in about 30 seconds/)).toBeTruthy();
    expect(sequence()).toEqual([
      `POST ${START}`,
      `PUT ${SESSION}?offset=0`,
      `PUT ${SESSION}?offset=${MIB}`,
      `PUT ${SESSION}?offset=${2 * MIB}`,
      `POST ${SESSION}`,
    ]);
    expect(JSON.parse(requests[0].body as string)).toEqual({ name: 'budget-2026-08-16.tar.gz', bytes: 3 * MIB, confirm: true });
    expect(requests[0].headers['content-type']).toBe('application/json');
    for (const piece of requests.slice(1, 4)) {
      expect(piece.headers['content-type']).toBe('application/octet-stream');
      expect(sizeOf(piece)).toBe(MIB);
    }
  });

  it('swaps the page for the restarting notice on success', async () => {
    answer = (request) => {
      if (request.method === 'POST' && request.url === START) return [200, { id: ID, chunkBytes: 4 }];
      if (request.method === 'PUT') return [200, { received: offsetOf(request) + sizeOf(request) }];
      return [200, restarting];
    };
    render(<BackupsClient backups={backups} retention={14} upload={{ maxBytes: 64, chunkBytes: 4 }} restore={noRestore} />);
    chooseFile(fileOf(10));
    startUpload();

    expect(await screen.findByText(restarting.message)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows a refused archive in the card and drops the upload', async () => {
    const refusal = 'That file is neither a .tar.gz archive nor a SQLite backup. Nothing was changed.';
    answer = (request) => {
      if (request.method === 'POST' && request.url === START) return [200, { id: ID, chunkBytes: 4 }];
      if (request.method === 'PUT') return [200, { received: offsetOf(request) + sizeOf(request) }];
      if (request.method === 'POST') return [422, { error: refusal }];
      return [404, { error: 'That upload was not found. Start it again.' }];
    };
    render(<BackupsClient backups={backups} retention={14} upload={{ maxBytes: 64, chunkBytes: 4 }} restore={noRestore} />);
    chooseFile(fileOf(10));
    startUpload();

    expect(await screen.findByText(refusal)).toBeTruthy();
    expect(sequence().at(-1)).toBe(`DELETE ${SESSION}`);
    expect(screen.getByLabelText('Backup file to restore')).toBeTruthy();
  });

  it('retries a failed piece once, from where the server says the upload stands', async () => {
    let failedOnce = false;
    answer = (request) => {
      if (request.method === 'POST' && request.url === START) return [200, { id: ID, chunkBytes: 4 }];
      if (request.method === 'PUT' && offsetOf(request) === 4) {
        // The piece arrived but the answer was lost: the retry hears that the server is ahead.
        if (!failedOnce) {
          failedOnce = true;
          return 'network';
        }
        return [409, { error: 'The upload has 8 bytes so far; send the next piece from there.', received: 8 }];
      }
      if (request.method === 'PUT') return [200, { received: offsetOf(request) + sizeOf(request) }];
      return [200, restarting];
    };
    render(<BackupsClient backups={backups} retention={14} upload={{ maxBytes: 64, chunkBytes: 4 }} restore={noRestore} />);
    chooseFile(fileOf(10));
    startUpload();

    expect(await screen.findByText(restarting.message)).toBeTruthy();
    expect(sequence()).toEqual([
      `POST ${START}`,
      `PUT ${SESSION}?offset=0`,
      `PUT ${SESSION}?offset=4`,
      `PUT ${SESSION}?offset=4`,
      `PUT ${SESSION}?offset=8`,
      `POST ${SESSION}`,
    ]);
  });

  it('gives up after the one retry, says why and drops the upload', async () => {
    answer = (request) => {
      if (request.method === 'POST' && request.url === START) return [200, { id: ID, chunkBytes: 4 }];
      if (request.method === 'PUT' && offsetOf(request) === 4) return [500, { error: 'The upload could not be handled. Nothing was changed.' }];
      if (request.method === 'PUT') return [200, { received: offsetOf(request) + sizeOf(request) }];
      return [200, {}];
    };
    render(<BackupsClient backups={backups} retention={14} upload={{ maxBytes: 64, chunkBytes: 4 }} restore={noRestore} />);
    chooseFile(fileOf(10));
    startUpload();

    expect(await screen.findByText('The upload could not be handled. Nothing was changed.')).toBeTruthy();
    expect(sequence()).toEqual([
      `POST ${START}`,
      `PUT ${SESSION}?offset=0`,
      `PUT ${SESSION}?offset=4`,
      `PUT ${SESSION}?offset=4`,
      `DELETE ${SESSION}`,
    ]);
  });

  it('shows a refused start in the card and sends nothing more', async () => {
    const lowSpace = 'This restore needs about 3.1 GB free on the data volume; 1.2 GB is free. Nothing was changed.';
    answer = () => [507, { error: lowSpace }];
    render(<BackupsClient backups={backups} retention={14} upload={{ maxBytes: 64, chunkBytes: 4 }} restore={noRestore} />);
    chooseFile(fileOf(10));
    startUpload();

    expect(await screen.findByText(lowSpace)).toBeTruthy();
    expect(sequence()).toEqual([`POST ${START}`]);
  });

  it('is disabled while a restore is staged', () => {
    render(
      <BackupsClient
        backups={backups}
        retention={14}
        upload={limits}
        restore={{
          staged: {
            version: 1,
            payload: 'payload',
            sourceName: 'uploaded: budget-2026-08-16.tar.gz',
            kind: 'archive',
            bytes: 4_194_304,
            sha256: '0'.repeat(64),
            appliedMigrations: 4,
            requestedByUserId: 3,
            requestedByUsername: 'alex',
            requestedAt: '2026-08-16T21:04:11.482Z',
            appVersion: '1.63.0',
          },
          result: null,
        }}
      />,
    );
    expect((screen.getByLabelText('Backup file to restore') as HTMLInputElement).disabled).toBe(true);
  });

  it('v1.63.0 fix round: a progress bar, and a live region there before the upload that speaks only at coarse steps', async () => {
    const said: string[] = [];
    answer = (request) => {
      if (request.method === 'POST' && request.url === START) return [200, { id: ID, chunkBytes: 1 }];
      if (request.method === 'PUT') return null; // answered by hand below
      return [200, restarting];
    };
    render(<BackupsClient backups={backups} retention={14} upload={{ maxBytes: 64, chunkBytes: 1 }} restore={noRestore} />);
    const announcer = screen.getByTestId('upload-announcer');
    // Present, polite and empty before anything is chosen or sent.
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toBe('');
    const observer = new MutationObserver(() => {
      if (announcer.textContent) said.push(announcer.textContent);
    });
    observer.observe(announcer, { childList: true, subtree: true, characterData: true });

    chooseFile(fileOf(20));
    expect(screen.getByTestId('upload-announcer')).toBe(announcer);
    startUpload();

    // Twenty one-byte pieces, each answered with its progress event first.
    for (let index = 0; index < 20; index += 1) {
      const piece = await waitFor(() => {
        const found = requests.find((request) => request.method === 'PUT' && offsetOf(request) === index);
        expect(found).toBeTruthy();
        return found!;
      });
      if (index === 10) {
        const bar = screen.getByRole('progressbar', { name: 'Upload progress' }) as HTMLProgressElement;
        expect(bar.tagName).toBe('PROGRESS');
        expect(bar.max).toBe(20);
        expect(bar.value).toBe(10);
        expect(screen.getByText('Uploading 0 of 1 MB')).toBeTruthy();
      }
      act(() => piece.respond(200, { received: index + 1 }));
    }
    expect(await screen.findByText(restarting.message)).toBeTruthy();
    observer.disconnect();

    expect(said).toEqual([
      'Upload started.',
      'Uploaded 10%.',
      'Uploaded 20%.',
      'Uploaded 30%.',
      'Uploaded 40%.',
      'Uploaded 50%.',
      'Uploaded 60%.',
      'Uploaded 70%.',
      'Uploaded 80%.',
      'Uploaded 90%.',
      'Upload finished. Checking the backup. A large archive can take a few minutes.',
    ]);
  });

  it('v1.63.0 fix round: says before a large upload that checking it pauses the app, and not before a small one', () => {
    render(<BackupsClient backups={backups} retention={14} upload={limits} restore={noRestore} />);
    chooseFile(fileOf(10));
    expect(screen.queryByText(/the app pauses/)).toBeNull();
    const large = fileOf(10, 'budget-2026-08-17.tar.gz');
    Object.defineProperty(large, 'size', { value: 600 * MIB });
    chooseFile(large);
    expect(
      screen.getByText('Checking a file this size can take a few minutes, and the app pauses for everyone until it is done.'),
    ).toBeTruthy();
  });
});
