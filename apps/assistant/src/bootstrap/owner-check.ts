/**
 * Startup consistency between configuration and the database (audit F18). In production the configured owner id is mandatory and
 * the database must contain exactly that one owner; elsewhere a configured id must still match any owner that exists. Returns an
 * error message, or null when consistent. Pure so it is unit-testable.
 */
export function verifyConfiguredOwner(a: { production: boolean; configured: string | undefined; owners: Array<{ telegram_user_id: string }> }): string | null {
  const { production, configured, owners } = a;
  if (production && !configured) return 'OWNER_TELEGRAM_USER_ID is required in production';
  if (owners.length > 1) return `the database contains ${owners.length} owners; this deployment serves exactly one`;
  if (production && owners.length !== 1)
    return 'the owner is not bootstrapped in the database (run `pnpm bootstrap:owner`): production needs exactly one owner';
  if (configured && owners[0] && owners[0].telegram_user_id !== configured) return 'OWNER_TELEGRAM_USER_ID does not match the owner in the database';
  return null;
}
