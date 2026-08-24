import { requireUser } from '@/lib/auth/session';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { HELP_ROUTINE, HELP_SECTIONS, type HelpSection } from './content';

export const dynamic = 'force-dynamic';

/**
 * The handbook, rendered flat.
 *
 * Ruling A8 — there is no <details> on this page and there must never be one. Collapsed
 * <details> cannot be reliably forced open by print CSS (engines hide the closed content
 * differently), and the browser's own Print-to-PDF is how this app ships a printable handbook
 * without a PDF toolchain. Every section is therefore expanded, and the table of contents does
 * the job that collapsing would otherwise do: it makes a long page navigable on screen while
 * leaving it complete on paper. The @media print block in src/app/globals.css drops the app
 * chrome; `print:hidden` here drops the two on-screen affordances that mean nothing printed.
 *
 * The page needs no data of its own. It calls requireUser() anyway, matching every other page
 * in this route group: the layout above already gates the group, and each page repeating the
 * check is what keeps that gate from being a single point of failure.
 */
export default async function HelpPage() {
  await requireUser();
  const sections = [HELP_ROUTINE, ...HELP_SECTIONS];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Help"
        description="What each screen is for, in the order you meet them, plus the parts of the app that no screen advertises."
      />

      <p className="text-sm text-muted print:hidden">
        This page is the whole manual. To keep a copy, print it from your browser — the menus and
        the header drop out and only the text comes through.
      </p>

      <nav
        aria-label="On this page"
        className="sticky top-16 z-20 flex flex-wrap gap-x-3 gap-y-1.5 rounded-md border border-line bg-surface/95 px-3.5 py-3 backdrop-blur-md print:hidden"
      >
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="text-sm text-accent-text underline underline-offset-2"
          >
            {section.title}
          </a>
        ))}
      </nav>

      {sections.map((section) => (
        <HelpArticle key={section.id} section={section} />
      ))}
    </div>
  );
}

/** `scroll-mt-32` clears the shell header plus the sticky contents list above, so a jump from
 *  the table of contents does not land the heading underneath either of them. */
function HelpArticle({ section }: { section: HelpSection }) {
  return (
    <section id={section.id} className="scroll-mt-32">
      <Card as="article">
        <CardHeader title={section.title} />
        <CardBody className="flex flex-col gap-3">{section.body}</CardBody>
      </Card>
    </section>
  );
}
