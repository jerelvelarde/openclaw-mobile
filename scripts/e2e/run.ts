// Live E2E runner — drives the scenario in `driver.ts` against a real
// `openclaw gateway` container (P11E).
//
// Assumes the caller has already brought the gateway up (via
// `docker compose -f e2e/docker/docker-compose.yml up -d`) and that
// the `/health` endpoint returns 200. The CI workflow + the
// `e2e:clawg-ui:local` script handle that orchestration; this script
// is intentionally narrow so it can be invoked standalone too.
//
// Environment variables:
//   OPENCLAW_E2E_BASE_URL — default `http://localhost:18789`.
//   OPENCLAW_E2E_CONTAINER — name of the docker container to `docker
//     exec` into for the approve step. Defaults to
//     `openclaw-gateway-e2e`, which matches `docker-compose.yml`.
//   OPENCLAW_E2E_REPORT — path to write the JSON report. Defaults to
//     `./e2e-report.json` (relative to cwd).
//
// Exit codes:
//   0 — scenario passed every assertion.
//   1 — at least one assertion failed (full report still written).
//   2 — uncaught crash (the runner itself misbehaved).

import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { runScenario, type ApproveResult } from './driver.ts';

const BASE_URL = process.env.OPENCLAW_E2E_BASE_URL ?? 'http://localhost:18789';
const CONTAINER = process.env.OPENCLAW_E2E_CONTAINER ?? 'openclaw-gateway-e2e';
const REPORT_PATH = resolve(process.cwd(), process.env.OPENCLAW_E2E_REPORT ?? 'e2e-report.json');

/**
 * Shell out to `docker exec <container> openclaw pairing approve
 * clawg-ui <code>`. Mirrors the CLI shape that
 * `apps/desktop/src/main/clawg-ui/cli.ts` wraps in production — we
 * deliberately do NOT import that wrapper because the live harness
 * should treat the desktop client as a peer-under-test, not as a
 * dependency.
 */
function approveViaDockerExec(code: string): Promise<ApproveResult> {
  return new Promise((resolveApprove) => {
    const child = spawn(
      'docker',
      ['exec', CONTAINER, 'openclaw', 'pairing', 'approve', 'clawg-ui', code],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      resolveApprove({ ok: false, detail: `spawn failed: ${err.message}` });
    });
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolveApprove({ ok: true, detail: stdout.trim() || undefined });
      } else {
        resolveApprove({
          ok: false,
          detail: `exit ${exitCode}: ${stderr.trim() || stdout.trim() || 'no output'}`,
        });
      }
    });
  });
}

async function main(): Promise<void> {
  const report = await runScenario({
    baseUrl: BASE_URL,
    approve: approveViaDockerExec,
  });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  // Echo a compact summary to stdout so CI logs surface the outcome
  // without forcing the reader to download the artifact.
  const failed = report.assertions.filter((a) => !a.passed);
  console.log(
    `[e2e] ${report.passed ? 'PASS' : 'FAIL'} — ${report.assertions.length - failed.length}/${
      report.assertions.length
    } assertions, ${report.events.length} SSE events, ${report.durationMs}ms`,
  );
  if (failed.length > 0) {
    for (const a of failed) {
      console.log(`[e2e]   FAIL ${a.name} — ${a.detail ?? '(no detail)'}`);
    }
  }
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[e2e] uncaught error:', err);
  process.exit(2);
});
