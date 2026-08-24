import {
  BudgetsIcon,
  DashboardIcon,
  GoalsIcon,
  ImportIcon,
  InfoIcon,
  ReportsIcon,
  ReviewIcon,
  SettingsIcon,
  TransactionsIcon,
  WarrantiesIcon,
  type IconProps,
} from '@/components/icons';

export interface NavItem {
  href: string;
  label: string;
  Icon: (props: IconProps) => React.ReactElement;
}

/**
 * Ten entries, and only the first nine are a sequence. Those nine follow the order
 * money moves through the app: see the month, check the transactions behind it, fix
 * what the categorizer was unsure of, bring more in, then the planning surfaces,
 * then the back office. Help is not a step in that flow -- it sits outside it, and
 * is last only because a list has to end somewhere, not because it comes after
 * Settings.
 *
 * The count and that distinction are written down because this docblock is the only
 * thing telling the next reader where a new entry belongs. A docblock that still
 * describes the list it used to match is how the list gets mis-ordered: the same
 * failure v1.9.0 had to fix in src/proxy.ts, where a stale rationale outlived the
 * rule it justified. A new *section* goes in the money-flow run, at the point where
 * it belongs in that flow, and this count moves with it; Help stays at the end.
 */
export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { href: '/transactions', label: 'Transactions', Icon: TransactionsIcon },
  { href: '/review', label: 'Review', Icon: ReviewIcon },
  { href: '/import', label: 'Import', Icon: ImportIcon },
  { href: '/budgets', label: 'Budgets', Icon: BudgetsIcon },
  { href: '/goals', label: 'Goals', Icon: GoalsIcon },
  // v1.2.2 Task 2: renamed from "Warranties" -- the tracker now covers warranties,
  // subscriptions, contracts and loans. No dedicated short-label mechanism exists on NavItem
  // (checked AppShell: NavList already renders every label inside a `truncate` span in both
  // the desktop rail and the phone menu), so this longer label relies on that existing
  // ellipsis behaviour rather than introducing a new field for one nav item.
  { href: '/warranties', label: 'Contracts & Coverage', Icon: WarrantiesIcon },
  { href: '/reports', label: 'Reports', Icon: ReportsIcon },
  { href: '/settings', label: 'Settings', Icon: SettingsIcon },
  { href: '/help', label: 'Help', Icon: InfoIcon },
];

/**
 * Longest prefix wins, so /settings/backups still lights up Settings and
 * /warranties/12 still lights up Warranties.
 */
export function activeNavItem(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of NAV) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best;
}
