import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { findUserByUsername } from '@/lib/auth/users';
import { countUnusedRecoveryCodes } from '@/lib/auth/totp';
import {
  ArrowRightIcon,
  BellIcon,
  BudgetsIcon,
  ImportIcon,
  SettingsIcon,
  SignOutIcon,
  TransactionsIcon,
  WarrantiesIcon,
  type IconProps,
} from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { isOcrFailingSystemically } from '@/lib/warranty/ocr/health';
import { readEffectiveOcrEngine, readOcrEngineState } from '@/lib/warranty/ocr/onnx/probe';
import { AboutPanel } from './about-panel';
import { ProfileForms } from './profile-forms';
import { UpdatesCard } from './updates-card';

export const dynamic = 'force-dynamic';

/** The admin surfaces, each with the one sentence that says what it is for. */
const ADMIN_LINKS: { href: string; label: string; blurb: string; Icon: (props: IconProps) => React.ReactElement }[] = [
  { href: '/settings/users', label: 'Users', blurb: 'Who can sign in, and what they may change.', Icon: SettingsIcon },
  { href: '/settings/item-types', label: 'Item types', blurb: 'The warranty categories, and which are subscriptions.', Icon: WarrantiesIcon },
  { href: '/settings/accounts', label: 'Bank accounts', blurb: 'Where imported transactions land.', Icon: BudgetsIcon },
  {
    href: '/settings/managers',
    label: 'Categories, merchant rules and import profiles',
    blurb: 'How transactions get named and sorted.',
    Icon: TransactionsIcon,
  },
  { href: '/settings/backups', label: 'Backups', blurb: 'Nightly archives, downloads and restore.', Icon: ImportIcon },
  { href: '/settings/connections', label: 'Connections (SimpleFIN)', blurb: 'Bank sync instead of CSV, where it is set up.', Icon: ImportIcon },
  // v1.13.0 ruling R3.
  { href: '/settings/audit', label: 'Audit log', blurb: 'Every deletion and every undone import, with who did it.', Icon: SettingsIcon },
];

export default async function SettingsPage() {
  const user = await requireUser();
  const record = findUserByUsername(user.username);
  const recoveryLeft = countUnusedRecoveryCodes(user.id);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader title="Settings" description="Your account, and — for admins — how the household's data is managed." />

      <PageGuide>
        <p>
          Everything here is configuration rather than money. The top of the page is your own
          account — your name, your password, and two-factor sign-in if you want it — and it
          looks the same for everyone.
        </p>
        <p>
          Of the admin sections below, <strong className="font-semibold text-ink">Bank
          accounts</strong> is the one that has to be done first: an import has to land in an
          account, so nothing can be brought in until at least one exists. Alongside it,
          Categories, merchant rules and import profiles is where you adjust how imported rows
          get named and sorted, and where a bank&rsquo;s import mapping can be switched off
          without deleting it if you stop using that bank.
        </p>
        <p>
          The rest is optional and can wait. Notifications decide whether the app messages you
          and where; nothing is sent anywhere until a channel is set up. Backups covers the
          nightly archive, downloading one, and restoring it. Users controls who can sign in and
          what they are allowed to change. Connections is for bank sync, which is an alternative
          to CSV import rather than a requirement for it.
        </p>
      </PageGuide>

      <Card>
        <CardHeader
          title="Profile"
          description={
            <>
              Signed in as <strong className="font-semibold text-ink">{user.name}</strong> ({user.username}) — {user.role}
            </>
          }
        />
        <CardBody>
          <ProfileForms totpEnabled={record?.totpEnabled ?? false} recoveryLeft={recoveryLeft} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Sessions" description="Signs you out on every device, including this one." />
        <CardBody>
          <form action="/api/auth/logout" method="post">
            <input type="hidden" name="scope" value="all" />
            <button type="submit" className="btn btn--secondary">
              <SignOutIcon className="h-4 w-4" />
              Log out everywhere
            </button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Notifications" description="Where the app messages you, and about what." />
        <CardBody>
          <Link
            href="/settings/notifications"
            className="group flex items-start gap-3 rounded-md p-1 transition-colors hover:text-accent-text"
          >
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-fg"
            >
              <BellIcon className="h-[1.15rem] w-[1.15rem]" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-semibold text-ink">Notifications</span>
              <span className="text-sm text-muted">Telegram and email alerts. Nothing is sent until you set a channel up.</span>
            </span>
            <ArrowRightIcon className="mt-1 h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
          </Link>
        </CardBody>
      </Card>

      {user.role === 'admin' ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-ink">Administration</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {ADMIN_LINKS.map(({ href, label, blurb, Icon }) => (
              <Link
                key={href}
                href={href}
                className="card group flex items-start gap-3 p-4 transition-colors hover:border-accent-text"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-fg"
                >
                  <Icon className="h-[1.15rem] w-[1.15rem]" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-ink">{label}</span>
                  <span className="text-sm text-muted">{blurb}</span>
                </span>
                <ArrowRightIcon className="mt-1 h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* MUST-9.1: admin only. A member's Settings page is byte-identical to v1.3.0's. */}
      {user.role === 'admin' ? <UpdatesCard /> : null}

      {/* Last: the version and revision log are reference material, not a task. */}
      <AboutPanel ocr={readOcrEngineState()} liveEngine={readEffectiveOcrEngine()} systemic={isOcrFailingSystemically()} />
    </div>
  );
}
