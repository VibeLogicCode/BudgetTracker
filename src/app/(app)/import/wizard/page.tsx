import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { heldFileFromParams } from '@/lib/import/held-file';
import { getBuiltinPreset } from '@/lib/import/presets';
import { WizardClient } from './wizard-client';

export const dynamic = 'force-dynamic';

export default async function ImportWizardPage({
  searchParams,
}: {
  // Optional so the page still renders when called bare (tests/app/import-wizard-page.test.ts).
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const user = await requireUser();
  // Controller ruling: the wizard is part of Import, gated the same way import/page.tsx is --
  // nav hiding alone is insufficient for a self viewer.
  if (isSelfScoped(user)) redirect('/dashboard');
  // v1.55.2: `?stagingId=&filename=` is a file the import screen already holds. The id is only
  // passed through here; /api/import/raw-preview validates it and reads the bytes.
  return (
    <WizardClient
      starterMapping={getBuiltinPreset('Scotiabank Chequing/Debit')}
      heldFile={heldFileFromParams((await searchParams) ?? {})}
    />
  );
}
