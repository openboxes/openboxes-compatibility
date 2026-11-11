import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type Check, compare, loadResultSet, main, renderReport } from './compare';

const EXPECTED = ['api > getAppContext answers JSON', 'pages > dashboard renders'];

const root = mkdtempSync(join(tmpdir(), 'compare-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function deployChecks(overrides: Partial<Record<string, Partial<Check>>> = {}): Check[] {
  const base: Check[] = [
    { id: 'deploy.ready', kind: 'assertion', status: 'pass', value: 'true' },
    { id: 'deploy.java_major', kind: 'assertion', status: 'pass', value: '8' },
    { id: 'deploy.health_path', kind: 'assertion', status: 'pass', value: '/health' },
    { id: 'deploy.boot_log_errors', kind: 'assertion', status: 'pass', value: '0' },
    { id: 'deploy.java_version', kind: 'fact', status: 'pass', value: '1.8.0_492' },
  ];
  return base.map((c) => ({ ...c, ...overrides[c.id] }));
}

function playwright(statuses: Record<string, string> = {}, errors: unknown[] = []): unknown {
  return {
    errors,
    suites: [
      {
        title: 'app-context.spec.ts',
        specs: [
          {
            title: 'getAppContext answers JSON',
            tests: [{ projectName: 'api', status: statuses.api ?? 'expected', results: [] }],
          },
        ],
      },
      {
        title: 'dashboard.spec.ts',
        specs: [
          {
            title: 'dashboard renders',
            tests: [{ projectName: 'pages', status: statuses.pages ?? 'expected', results: [] }],
          },
        ],
      },
    ],
  };
}

interface Side {
  deploy?: unknown;
  playwright?: unknown;
  raw?: Record<string, string>;
}

let counter = 0;
// expected: null stands for "the suite could not be listed".
function run(baseline: Side, candidate: Side, expected: string[] | null = EXPECTED) {
  const dir = join(root, String(counter++));
  for (const [label, side] of [
    ['b', baseline],
    ['c', candidate],
  ] as const) {
    mkdirSync(join(dir, label), { recursive: true });
    if (side.deploy !== undefined) {
      writeFileSync(join(dir, label, 'deploy.json'), JSON.stringify(side.deploy));
    }
    if (side.playwright !== undefined) {
      writeFileSync(join(dir, label, 'playwright.json'), JSON.stringify(side.playwright));
    }
    for (const [file, text] of Object.entries(side.raw ?? {})) {
      writeFileSync(join(dir, label, file), text);
    }
  }
  const b = loadResultSet(dir, 'b');
  const c = loadResultSet(dir, 'c');
  const result = compare(b, c, expected ?? undefined);
  // The report must render for every outcome.
  assert.match(renderReport(b, c, result), /Verdict: /);
  return result;
}

const good = (): Side => ({ deploy: { checks: deployChecks() }, playwright: playwright() });

describe('compare verdicts', () => {
  it('passes when both sides pass every check', () => {
    assert.equal(run(good(), good()).verdict, 'PASS');
  });

  it('fails on a value difference in a compared assertion', () => {
    const c = good();
    c.deploy = { checks: deployChecks({ 'deploy.java_major': { value: '17' } }) };
    const r = run(good(), c);
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(r.differences, ['deploy.java_major']);
  });

  it('ignores differences in recorded facts', () => {
    const c = good();
    c.deploy = { checks: deployChecks({ 'deploy.java_version': { value: '1.8.0_504' } }) };
    assert.equal(run(good(), c).verdict, 'PASS');
  });

  it('fails on a test regression', () => {
    const r = run(good(), { ...good(), playwright: playwright({ pages: 'unexpected' }) });
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(r.regressions, ['pages > dashboard renders']);
  });

  it('fails when the candidate is not ready, whatever else is missing', () => {
    const r = run(good(), {
      deploy: { checks: deployChecks({ 'deploy.ready': { status: 'fail', value: 'false' } }) },
    });
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.decidedBy, 1);
  });

  it('fails when the candidate app container does not start', () => {
    const r = run(good(), {
      deploy: {
        checks: [
          {
            id: 'deploy.ready',
            kind: 'assertion',
            status: 'fail',
            value: 'false',
            detail: 'app container did not start',
          },
        ],
      },
    });
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.decidedBy, 1);
  });

  it('is inconclusive when the candidate stack failed for infra reasons', () => {
    const r = run(good(), {
      deploy: {
        checks: [{ id: 'deploy.stack', kind: 'assertion', status: 'fail', class: 'infra' }],
      },
    });
    assert.equal(r.verdict, 'INCONCLUSIVE');
  });

  it('fails on a failing candidate-only assertion', () => {
    const c = good();
    c.deploy = {
      checks: [...deployChecks(), { id: 'deploy.extra', kind: 'assertion', status: 'fail' }],
    };
    const r = run(good(), c);
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(r.candidateOnlyFailures, ['deploy.extra']);
  });

  it('is inconclusive when a baseline result file is missing', () => {
    assert.equal(run({ deploy: good().deploy }, good()).verdict, 'INCONCLUSIVE');
  });

  it('is inconclusive when both Playwright runs are empty', () => {
    const empty = { ...good(), playwright: { suites: [] } };
    assert.equal(run(empty, empty).verdict, 'INCONCLUSIVE');
  });

  it('is inconclusive when a Playwright run reports a top-level error', () => {
    const errored = { ...good(), playwright: playwright({}, [{ message: 'global setup failed' }]) };
    const r = run(good(), errored);
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.match(r.reasons.join('\n'), /global setup failed/);
  });

  it('is inconclusive when a suite check is absent from both sides', () => {
    const r = run(good(), good(), [...EXPECTED, 'api > another check']);
    assert.equal(r.verdict, 'INCONCLUSIVE');
  });

  it('counts a suite check absent only on the candidate as a regression', () => {
    const c = good();
    c.playwright = { suites: [(playwright() as { suites: unknown[] }).suites[0]] };
    const r = run(good(), c);
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(r.regressions, ['pages > dashboard renders']);
  });

  it('is inconclusive when a required deployment check is absent', () => {
    const partial = { ...good(), deploy: { checks: deployChecks().slice(1) } };
    assert.equal(run(partial, partial).verdict, 'INCONCLUSIVE');
  });

  it('is inconclusive when the suite cannot be listed', () => {
    assert.equal(run(good(), good(), null).verdict, 'INCONCLUSIVE');
  });

  it('is inconclusive, not a crash, on malformed result files', () => {
    assert.equal(
      run(good(), { raw: { 'deploy.json': '{not json', 'playwright.json': '[]' } }).verdict,
      'INCONCLUSIVE'
    );
    assert.equal(
      run(good(), { deploy: { checks: [{ id: 'x' }] }, playwright: { suites: 'no' } }).verdict,
      'INCONCLUSIVE'
    );
  });

  it('is inconclusive when a check id is a fact on one side and an assertion on the other', () => {
    const c = good();
    c.deploy = {
      checks: deployChecks({ 'deploy.java_version': { kind: 'assertion' } }),
    };
    assert.equal(run(good(), c).verdict, 'INCONCLUSIVE');
  });

  it('is inconclusive, never failing-on-both, on unknown test statuses', () => {
    const odd = { ...good(), playwright: playwright({ api: 'exploded', pages: 'exploded' }) };
    const r = run(odd, odd);
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.match(r.reasons.join('\n'), /status is unknown/);
  });

  it('is inconclusive, not a crash, on malformed nested Playwright structure', () => {
    const shapes: unknown[] = [
      { suites: [{ title: 'f', specs: [{ title: 't', tests: 'no' }] }] },
      { suites: [{ title: 'f', specs: [{ title: 't', tests: [{ projectName: 'api' }] }] }] },
      { suites: [{ title: 'f', suites: [{ specs: [] }] }] },
      { suites: [{ title: 'f', specs: 'no' }] },
      { suites: [null] },
      { suites: [], errors: 'no' },
    ];
    for (const shape of shapes) {
      assert.equal(run(good(), { ...good(), playwright: shape }).verdict, 'INCONCLUSIVE');
    }
  });

  it('is inconclusive when a required deployment assertion is recorded as a fact', () => {
    const facts = {
      ...good(),
      deploy: { checks: deployChecks({ 'deploy.java_major': { kind: 'fact' } }) },
    };
    const r = run(facts, facts);
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.match(r.reasons.join('\n'), /deploy.java_major is recorded as a fact/);
  });

  it('is inconclusive when a required check failed on the baseline and is missing on the candidate', () => {
    const b = { ...good(), playwright: playwright({ pages: 'unexpected' }) };
    const c = good();
    c.playwright = { suites: [(playwright() as { suites: unknown[] }).suites[0]] };
    assert.equal(run(b, c).verdict, 'INCONCLUSIVE');
  });

  it('is inconclusive, not a candidate failure, when neither side is ready', () => {
    const notReady = {
      deploy: { checks: deployChecks({ 'deploy.ready': { status: 'fail', value: 'false' } }) },
    };
    const r = run(notReady, notReady);
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.equal(r.decidedBy, 2);
  });

  it('treats inherited property names as unknown test statuses', () => {
    for (const status of ['toString', '__proto__', 'constructor']) {
      const odd = { ...good(), playwright: playwright({ api: status, pages: status }) };
      assert.equal(run(odd, odd).verdict, 'INCONCLUSIVE');
    }
  });

  it('does not blame the candidate when the baseline readiness is missing', () => {
    const b = { ...good(), deploy: { checks: deployChecks().slice(1) } };
    const c = {
      deploy: { checks: deployChecks({ 'deploy.ready': { status: 'fail', value: 'false' } }) },
    };
    const r = run(b, c);
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.equal(r.decidedBy, 2);
  });

  it('does not blame the candidate when its readiness is recorded as a fact', () => {
    const c = {
      ...good(),
      deploy: {
        checks: deployChecks({ 'deploy.ready': { kind: 'fact', status: 'fail', value: 'false' } }),
      },
    };
    const r = run(good(), c);
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.equal(r.decidedBy, 2);
  });

  it('exits 3 on an unknown option instead of throwing', () => {
    assert.equal(main(['--bogus']), 3);
  });
});
