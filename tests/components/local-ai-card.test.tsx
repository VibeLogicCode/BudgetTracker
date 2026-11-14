// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { LocalAiCard, type LocalAiCardProps } from '@/app/(app)/settings/connections/local-ai-card';

/** v1.64.0 Lane B (plan 2026-11-12, B2). Props only; the four actions are mocks. */
const actions = vi.hoisted(() => ({
  save: vi.fn(async (_prev: unknown, _form: FormData) => ({ message: 'Local AI is on: test-model:1b at 192.168.1.50:11434. Suggestions start shortly.' })),
  test: vi.fn(async (_prev: unknown, _form: FormData) => ({ message: 'test-model:1b answered in 1.2 seconds.', models: ['test-model:1b', 'other-model:3b'] })),
  off: vi.fn(async (_prev: unknown, _form: FormData) => ({ message: 'Local AI is off.' })),
  forget: vi.fn(async (_prev: unknown, _form: FormData) => ({ message: 'Forgot 3 AI suggestions. Rows are unchanged.' })),
}));

vi.mock('@/app/(app)/settings/connections/ai-actions', () => ({
  saveLocalAiAction: actions.save,
  testLocalAiAction: actions.test,
  turnOffLocalAiAction: actions.off,
  forgetAiSuggestionsAction: actions.forget,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const counts = { suggested: 42, ignored: 0, failed: 0, toAsk: 180 };
function props(overrides: Partial<LocalAiCardProps> = {}): LocalAiCardProps {
  return {
    status: { state: 'off', failures: 0, lastError: null, counts: { suggested: 0, ignored: 0, failed: 0, toAsk: 0 } },
    lastOkLabel: null,
    nextTryLabel: null,
    baseUrl: '',
    model: '',
    ...overrides,
  };
}

describe('LocalAiCard status line', () => {
  it('off: says nothing is sent anywhere, and offers no Turn off or Forget', () => {
    render(<LocalAiCard {...props()} />);

    expect(screen.getByRole('status').textContent).toBe('Off. Nothing is sent anywhere.');
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget all AI suggestions' })).toBeNull();
    expect(screen.getByText(/only ever suggests/i)).toBeTruthy();
  });

  it('on with answers: names the last answer and the counts', () => {
    render(<LocalAiCard {...props({ status: { state: 'on', failures: 0, lastError: null, counts }, lastOkLabel: '14:32' })} />);

    expect(screen.getByRole('status').textContent).toBe('On. Last answer at 14:32. 42 merchants have a suggestion; about 180 are still to ask.');
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('on with no answer yet', () => {
    render(<LocalAiCard {...props({ status: { state: 'on', failures: 0, lastError: null, counts: { ...counts, suggested: 0 } } })} />);

    expect(screen.getByRole('status').textContent).toBe('On. No answer yet.');
  });

  it('switched on with a saved address that no longer passes: off, says why, and offers Turn off and Forget', () => {
    render(
      <LocalAiCard
        {...props({
          status: { state: 'off', enabled: true, failures: 0, lastError: null, counts: { suggested: 2, ignored: 1, failed: 0, toAsk: 0 } },
          baseUrl: 'http://[fd::1]:11434',
          model: 'test-model:1b',
        })}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe(
      'Off. The saved address or model is no longer accepted, so nothing is sent. Save a new one, or turn it off.',
    );
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Forget all AI suggestions' })).toBeTruthy();
  });

  it('waiting: names the failures, the next try and the last problem', () => {
    render(
      <LocalAiCard
        {...props({
          status: { state: 'waiting', failures: 3, lastError: 'Could not reach the model server at 192.168.1.50:11434.', counts },
          nextTryLabel: '15:10',
        })}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe(
      'Waiting after 3 failed tries. Next try about 15:10. Last problem: Could not reach the model server at 192.168.1.50:11434.',
    );
  });
});

describe('LocalAiCard forms', () => {
  it('Save posts the address and model, and shows the result', async () => {
    render(<LocalAiCard {...props({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save and turn on' }));

    await waitFor(() => expect(actions.save).toHaveBeenCalledTimes(1));
    const posted = actions.save.mock.calls[0][1];
    expect(posted.get('baseUrl')).toBe('http://192.168.1.50:11434');
    expect(posted.get('model')).toBe('test-model:1b');
    expect(await screen.findByText(/Suggestions start shortly/)).toBeTruthy();
  });

  it('Test posts the typed values to the test action only, and offers the listed models', async () => {
    render(<LocalAiCard {...props()} />);
    fireEvent.change(screen.getByLabelText('Model server address'), { target: { value: 'http://192.168.1.50:11434' } });
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'test-model:1b' } });

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    await waitFor(() => expect(actions.test).toHaveBeenCalledTimes(1));
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.test.mock.calls[0][1].get('baseUrl')).toBe('http://192.168.1.50:11434');
    expect(await screen.findByText(/test-model:1b answered in 1\.2 seconds/)).toBeTruthy();
    expect(document.querySelectorAll('#local-ai-models option')).toHaveLength(2);
  });

  it('Turn off posts its own form', async () => {
    render(<LocalAiCard {...props({ status: { state: 'on', failures: 0, lastError: null, counts }, lastOkLabel: '14:32' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));

    await waitFor(() => expect(actions.off).toHaveBeenCalledTimes(1));
  });

  it('Forget stays disabled until the box is ticked, then posts confirm', async () => {
    render(<LocalAiCard {...props({ status: { state: 'on', failures: 0, lastError: null, counts }, lastOkLabel: '14:32' })} />);
    const button = screen.getByRole('button', { name: 'Forget all AI suggestions' }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(actions.forget).toHaveBeenCalledTimes(1));
    expect(actions.forget.mock.calls[0][1].get('confirm')).toBe('1');
  });
});
