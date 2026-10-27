'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { isSetupRequired, runSetup } from '@/lib/auth/login';
import { passwordSchema } from '@/lib/auth/password';
import { clearSetupToken, verifySetupToken } from '@/lib/auth/setup-token';
import { setSessionCookie, shouldUseSecureCookie } from '@/lib/auth/session';
import { usernameSchema } from '@/lib/auth/users';

export interface SetupFormState {
  error?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
const SETUP_TOKEN_ERROR = 'That setup token does not match. Copy the current token from the server log.';

const setupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  username: usernameSchema,
  password: passwordSchema,
});

export async function setupAction(_prev: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const requestHeaders = await headers();

  // Binding ruling: same-origin check first thing, before any other logic.
  if (!isSameOrigin(requestHeaders)) {
    return { error: CROSS_ORIGIN_ERROR };
  }

  if (!isSetupRequired()) {
    redirect('/login');
  }
  // v1.58.1: the first-run token gates account creation; checked before anything is validated or written.
  const setupToken = formData.get('setupToken');
  if (typeof setupToken !== 'string' || !verifySetupToken(setupToken)) {
    return { error: SETUP_TOKEN_ERROR };
  }
  const parsed = setupSchema.safeParse({
    name: formData.get('name') ?? '',
    username: formData.get('username') ?? '',
    password: formData.get('password') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  }

  try {
    const result = await runSetup(parsed.data);
    clearSetupToken();
    // Controller ruling: pass 'http:' unconditionally — see the matching note in
    // src/app/(auth)/login/actions.ts. shouldUseSecureCookie's own TRUST_PROXY +
    // X-Forwarded-Proto branch is the sole HTTPS signal; a direct-HTTPS-without-
    // a-reverse-proxy deployment simply won't get a Secure cookie (the documented
    // HTTPS path is TRUST_PROXY behind a reverse proxy — see Task 19 / README).
    await setSessionCookie(result.token, result.expiresAt, shouldUseSecureCookie('http:', requestHeaders));
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Setup failed.' };
  }
  // On to the optional accounts step (spec section 6). It is skippable and
  // hands off to /dashboard either way.
  redirect('/setup/accounts');
}
