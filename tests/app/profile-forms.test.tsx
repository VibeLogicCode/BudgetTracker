// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ProfileForms } from '@/app/(app)/settings/profile-forms';

vi.mock('@/app/(app)/settings/actions', () => ({
  beginTotpEnrollmentAction: vi.fn(async () => ({})),
  changePasswordAction: vi.fn(async () => ({})),
  confirmTotpEnrollmentAction: vi.fn(async () => ({})),
  disableTotpAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

describe('v1.64.1: the Turn off two-factor form', () => {
  it('asks for the current password and a current code, and says who to ask without the authenticator', () => {
    const { container } = render(<ProfileForms totpEnabled recoveryLeft={6} />);
    const turnOff = Array.from(container.querySelectorAll('form')).find((form) => form.textContent?.includes('Turn off'));
    expect(turnOff).toBeDefined();
    const password = turnOff!.querySelector<HTMLInputElement>('input[name="currentPassword"]');
    const code = turnOff!.querySelector<HTMLInputElement>('input[name="currentCode"]');
    expect(password?.required).toBe(true);
    expect(code?.required).toBe(true);
    expect(code?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(turnOff!.textContent).toMatch(/ask an admin to reset two-factor/);
  });
});
