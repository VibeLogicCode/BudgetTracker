import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { getBuiltinPreset } from '@/lib/import/presets';
import { WizardClient } from './wizard-client';

export const dynamic = 'force-dynamic';

export default async function ImportWizardPage() {
  const user = await requireUser();
  // Controller ruling: the wizard is part of Import, gated the same way import/page.tsx is --
  // nav hiding alone is insufficient for a self viewer.
  if (isSelfScoped(user)) redirect('/dashboard');
  return <WizardClient starterMapping={getBuiltinPreset('Scotiabank Chequing/Debit')} />;
}
