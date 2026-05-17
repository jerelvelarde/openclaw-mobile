// Vitest setup for renderer (jsdom) tests.
//
// Auto-unmount React trees between tests so getByRole queries don't
// match leftover nodes from the previous test in the same file. The
// older `@testing-library/react@12` did this implicitly; v13+ requires
// the consumer to opt in (or call `cleanup()` manually).
//
// `vitest`'s `setupFiles` applies to every test file regardless of
// environment, so we feature-detect for a DOM before importing
// `@testing-library/react` (which throws under the `node` env used by
// our main-process tests).

import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cleanup } = require('@testing-library/react') as typeof import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
