import { readFileSync, statSync } from 'node:fs';

/**
 * Resolve a secret *reference*. Supported: `file:/abs/path` (mode must not be group/world readable) and `env:NAME`.
 * Literal secret values are never accepted in configuration.
 */
export function resolveSecret(ref: string, env: Record<string, string | undefined> = process.env): string {
  if (ref.startsWith('env:')) {
    const v = env[ref.slice(4)];
    if (!v) throw new Error(`secret reference ${ref} is unset`);
    return v;
  }
  if (ref.startsWith('file:')) {
    const path = ref.slice(5);
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) throw new Error(`secret file ${path} must not be group/world accessible (chmod 600)`);
    return readFileSync(path, 'utf8').trim();
  }
  throw new Error('secret reference must start with file: or env:');
}
