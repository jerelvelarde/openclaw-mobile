// Stable per-gateway identifier.
//
// Per `desktop-app.md` §2.2 the desktop app advertises a stable
// `gateway_id` (UUID per Mac) in Bonjour records, `/healthz`, and the
// signed pairing claim. We persist a UUID in `userData/gateway_id` on
// first launch and reload it thereafter; that file is plain-text on
// purpose — it isn't a secret, just an identifier.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Load `userData/gateway_id`, creating it on first launch. */
export function loadOrCreateGatewayId(userDataDir: string): string {
  const path = join(userDataDir, 'gateway_id');
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (value) return value;
  }
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}
