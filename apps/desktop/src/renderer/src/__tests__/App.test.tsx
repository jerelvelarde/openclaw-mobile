// Smoke test for the renderer shell. Verifies that <App /> mounts under
// jsdom and the placeholder heading is rendered. The IPC bridge is absent
// in this environment (no preload script under Vitest), and <App /> falls
// back to "(no bridge)" — we assert that to lock in the guard.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';

describe('<App />', () => {
  it('renders the openclaw-desktop heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'openclaw-desktop' })).toBeDefined();
  });

  it('falls back to a placeholder when window.api is missing', () => {
    const { container } = render(<App />);
    // jsdom doesn't run the preload script, so window.api is undefined and
    // the shell falls back to "(no bridge)". We assert against the whole
    // main element's text rather than a query that splits across nodes.
    expect(container.querySelector('main')?.textContent).toContain('(no bridge)');
  });
});
