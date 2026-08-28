// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Field, inputClass } from '@/components/ui/form';

afterEach(() => cleanup());

const HINT = 'What you borrowed. Used for the payoff bar.';

describe('Field — the hint is a description, never part of the name (item J, ruling P7)', () => {
  it('names the implicit-label input by its label alone', () => {
    render(
      <Field label="Original amount" hint={HINT}>
        <input className={inputClass} name="principal" />
      </Field>,
    );
    // Before this fix the accessible name was "Original amount What you borrowed. Used for the
    // payoff bar." and an exact getByLabelText could not find the field at all.
    expect(screen.getByLabelText('Original amount')).toBeTruthy();
  });

  it('still shows the hint, outside the <label>', () => {
    const { container } = render(
      <Field label="Original amount" hint={HINT}>
        <input className={inputClass} name="principal" />
      </Field>,
    );
    const hint = screen.getByText(HINT);
    expect(hint).toBeTruthy();
    expect(hint.closest('label')).toBeNull();
    expect(container.querySelector('label')).toBeTruthy();
  });

  it('describes the control when the caller supplied an id', () => {
    render(
      <Field label="Original amount" hint={HINT} htmlFor="loan-original">
        <input id="loan-original" className={inputClass} name="principal" />
      </Field>,
    );
    const input = screen.getByLabelText('Original amount');
    expect(input.getAttribute('aria-describedby')).toBe('loan-original-hint');
    expect(document.getElementById('loan-original-hint')?.textContent).toBe(HINT);
  });

  it('leaves a child that already describes itself alone', () => {
    render(
      <Field label="Original amount" hint={HINT} htmlFor="loan-original">
        <input id="loan-original" aria-describedby="something-else" className={inputClass} name="principal" />
      </Field>,
    );
    expect(screen.getByLabelText('Original amount').getAttribute('aria-describedby')).toBe('something-else');
  });

  it('renders unchanged with no hint at all', () => {
    render(
      <Field label="Name">
        <input className={inputClass} name="name" />
      </Field>,
    );
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  // Review B fix round, item 5. hintId used a `hint !== undefined && hint !== null` test, but
  // the hint <span> only renders under `{hint ? ... : null}` -- a truthy test. hint="" passed
  // the first and failed the second, so the control got aria-describedby pointing at an id
  // nothing ever rendered: a dangling reference.
  it('does not point aria-describedby at a hint id when hint is an empty string', () => {
    render(
      <Field label="Original amount" hint="" htmlFor="loan-original">
        <input id="loan-original" className={inputClass} name="principal" />
      </Field>,
    );
    const input = screen.getByLabelText('Original amount');
    expect(input.getAttribute('aria-describedby')).toBeNull();
    expect(document.getElementById('loan-original-hint')).toBeNull();
  });
});
