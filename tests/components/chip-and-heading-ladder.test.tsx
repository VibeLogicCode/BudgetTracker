// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Pill } from '@/components/ui/Pill';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { CardHeader } from '@/components/ui/Card';

afterEach(cleanup);

/**
 * 2026-09-15, `$impeccable critique` priority issue P2: "two badge systems and an inverted heading
 * ladder", both visible on the dashboard at once.
 */
describe('one chip geometry, two vocabularies', () => {
  /**
   * `.badge--*` is hue-named because warranty status is SPECIFIED by colour (spec 10.2: active
   * neutral, expiring amber, expired red, lifetime blue) and naming those after semantic tokens
   * would lose the mapping. `Pill` is semantic because MetricCard's tones are. Both are right;
   * what was wrong is that they were also two different SHAPES -- px-2 py-0.5 against px-2.5 py-1,
   * weight 550 against font-medium -- so one screen showed two sizes of the same idea.
   */
  it('Pill renders the .badge geometry rather than re-describing it', () => {
    render(<Pill tone="neutral">Needs a category</Pill>);
    const chip = screen.getByText('Needs a category');
    expect(chip.className).toContain('badge');
    // The geometry now comes from .badge in globals.css, so the component must not carry its own.
    expect(chip.className).not.toMatch(/\bpx-2\.5\b/);
    expect(chip.className).not.toMatch(/\bpy-1\b/);
    expect(chip.className).not.toMatch(/\brounded-full\b/);
  });

  it('maps every semantic tone onto the hue class that already carries those tokens', () => {
    const map = {
      neutral: 'badge--slate',
      accent: 'badge--accent',
      positive: 'badge--green',
      warning: 'badge--amber',
      negative: 'badge--red',
    } as const;
    for (const [tone, expected] of Object.entries(map)) {
      cleanup();
      render(<Pill tone={tone as keyof typeof map}>{tone}</Pill>);
      expect(screen.getByText(tone).className).toContain(expected);
    }
  });
});

/**
 * A SectionHeader introduces a whole GROUP of cards; a CardHeader titles ONE card. The section
 * used `.eyebrow` -- 11px uppercase --subtle -- while the card used 16px semibold --ink, so
 * "Goals", which heads an entire grid, read as subordinate to "Top merchants", which heads a
 * single card inside one. The ladder ran backwards.
 */
describe('the heading ladder runs the right way', () => {
  it('a section title outranks a card title visually', () => {
    render(<SectionHeader title="Goals" />);
    const section = screen.getByText('Goals').closest('h2') as HTMLElement;
    cleanup();
    render(<CardHeader title="Top merchants" />);
    const card = screen.getByText('Top merchants').closest('h2') as HTMLElement;

    // text-lg (1.125rem) over text-base (1rem): one step of the scale, not a shout.
    expect(section.className).toContain('text-lg');
    expect(card.className).toContain('text-base');
  });

  it('a section title is no longer an uppercase caption', () => {
    render(<SectionHeader title="Goals" />);
    const heading = screen.getByText('Goals').closest('h2') as HTMLElement;
    expect(heading.className).not.toContain('eyebrow');
    expect(heading.className).toContain('text-ink');
  });

  /** The eyebrow keeps the job it was invented for: naming what a StatTile's number counts. */
  it('both remain real headings for a screen reader', () => {
    render(<SectionHeader title="Goals" />);
    expect(screen.getByRole('heading', { name: 'Goals' }).tagName).toBe('H2');
  });
});
