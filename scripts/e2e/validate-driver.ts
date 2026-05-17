// Driver self-test (P11E).
//
// Runs `runScenario()` from `driver.ts` against the in-process mock
// peer in `mock-server.ts`. This proves the scenario logic + SSE
// parser are sound without needing a live Docker container.
//
// Why a hand-rolled runner rather than vitest: the plan asks us NOT to
// pull in an additional reporter framework just for the e2e lane, and
// this script lives outside any workspace's test glob so plain `pnpm
// -r test` won't pick it up. Exit code semantics:
//
//   0 — both happy-path + negative-control cases passed.
//   1 — any assertion failed; full driver report is dumped to stdout.
//
// Invoke via the root script `pnpm e2e:clawg-ui:mock`.

import { runScenario, type DriverReport } from './driver.ts';
import { startMockServer } from './mock-server.ts';

interface CaseResult {
  name: string;
  ok: boolean;
  report: DriverReport;
  expectedFailure?: string[];
}

async function runHappyPath(): Promise<CaseResult> {
  const mock = await startMockServer({ contentChunks: 2 });
  try {
    const report = await runScenario({
      baseUrl: mock.baseUrl,
      approve: (code) => mock.approve(code),
    });
    return { name: 'happy-path', ok: report.passed, report };
  } finally {
    await mock.close();
  }
}

/**
 * Negative control — confirms the driver flips `passed: false` when
 * the server intentionally omits `RUN_FINISHED`. If this case PASSED
 * the driver would be too lenient.
 */
async function runMissingRunFinished(): Promise<CaseResult> {
  const mock = await startMockServer({ contentChunks: 1, omitRunFinished: true });
  try {
    const report = await runScenario({
      baseUrl: mock.baseUrl,
      approve: (code) => mock.approve(code),
    });
    const failed = report.assertions.filter((a) => !a.passed).map((a) => a.name);
    // We expect exactly the RUN_FINISHED assertion to fail.
    const okShape = !report.passed && failed.includes('step4.event:RUN_FINISHED');
    return {
      name: 'missing-run-finished',
      ok: okShape,
      report,
      expectedFailure: ['step4.event:RUN_FINISHED'],
    };
  } finally {
    await mock.close();
  }
}

async function main(): Promise<void> {
  const cases = [await runHappyPath(), await runMissingRunFinished()];
  const allOk = cases.every((c) => c.ok);

  console.log(JSON.stringify({ ok: allOk, cases }, null, 2));
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('[validate-driver] uncaught error:', err);
  process.exit(2);
});
