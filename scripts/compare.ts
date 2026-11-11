/**
 * Compare the results of a baseline and a candidate and decide a verdict.
 *
 *   tsx scripts/compare.ts --baseline <label> --candidate <label> [--results <dir>] [--out <dir>]
 *   tsx scripts/compare.ts --candidate <label>      (single target: facts report, no verdict)
 *
 * Reads results/<label>/deploy.json (written by scripts/stack.sh) and
 * results/<label>/playwright.json (Playwright JSON reporter). The checks every
 * side must report are the required deployment assertions plus every test the
 * suite defines (`playwright test --list`), so a check that is silently
 * absent counts as missing rather than disappearing from the comparison.
 * Writes compat-report.md and compare.json to --out (default
 * results/compare/<baseline>..<candidate>) and prints the report.
 *
 * Exit code: 0 PASS (or single-target report), 1 FAIL, 2 INCONCLUSIVE,
 * 3 usage error.
 *
 * Verdict precedence:
 *   1. candidate build classified candidate-defect, or candidate not ready
 *      while the baseline was ready -> FAIL
 *   2. baseline build or boot failure (both sides not ready included), any
 *      infra/harness class, a missing, unreadable, malformed or errored result
 *      file, a required check missing on the baseline (or on the candidate
 *      when the baseline did not pass it), or a required assertion recorded
 *      as a fact -> INCONCLUSIVE
 *   3. a new regression (pass on baseline -> fail, skip or missing on the
 *      candidate) or a value difference in a compared assertion -> FAIL
 *   3a. a failing candidate-only assertion (no baseline counterpart) -> FAIL
 *   4. otherwise PASS
 * Facts are recorded and reported but never change the verdict.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export type Status = 'pass' | 'fail' | 'skip';
export type Kind = 'assertion' | 'fact';
export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface Check {
  id: string;
  kind: Kind;
  status: Status;
  value?: string;
  detail?: string;
  /** Failure class: candidate-defect, infra or harness. */
  class?: string;
}

export interface ResultSet {
  label: string;
  digest?: string;
  checks: Map<string, Check>;
  /** Result files that are missing, unreadable, malformed or report errors. */
  problems: string[];
}

/** Deployment assertions every lane must report (pass, fail or skip). */
export const REQUIRED_DEPLOY_CHECKS = [
  'deploy.ready',
  'deploy.java_major',
  'deploy.health_path',
  'deploy.boot_log_errors',
];

/** Statuses of a test in a Playwright JSON report. */
const PLAYWRIGHT_STATUSES: Record<string, Status> = {
  expected: 'pass',
  // A flaky test passed on retry; retries never change the verdict.
  flaky: 'pass',
  unexpected: 'fail',
  skipped: 'skip',
};

class MalformedReport extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayAt(value: Record<string, unknown>, key: string, where: string): unknown[] {
  const item = value[key];
  if (item === undefined) return [];
  if (!Array.isArray(item)) throw new MalformedReport(`${where}.${key} is not a list`);
  return item;
}

function stringAt(value: Record<string, unknown>, key: string, where: string): string {
  const item = value[key];
  if (typeof item !== 'string') throw new MalformedReport(`${where}.${key} is not a string`);
  return item;
}

/**
 * Walk a Playwright JSON report and visit every test as
 * "<project> > <describe titles> > <title>". Throws MalformedReport on any
 * structure it does not recognize. With `listing`, tests carry no results
 * (`playwright test --list`); otherwise every test needs a known status and a
 * results list.
 */
function walkPlaywright(
  report: unknown,
  listing: boolean,
  visit: (id: string, status: Status) => void
): void {
  if (!isObject(report) || !Array.isArray(report.suites)) {
    throw new MalformedReport('no suites list');
  }
  const walk = (suite: unknown, path: string[], where: string): void => {
    if (!isObject(suite)) throw new MalformedReport(`${where} is not an object`);
    arrayAt(suite, 'specs', where).forEach((spec, i) => {
      const specWhere = `${where}.specs[${i}]`;
      if (!isObject(spec)) throw new MalformedReport(`${specWhere} is not an object`);
      const title = stringAt(spec, 'title', specWhere);
      const tests = spec.tests;
      if (!Array.isArray(tests)) throw new MalformedReport(`${specWhere}.tests is not a list`);
      tests.forEach((test, j) => {
        const testWhere = `${specWhere}.tests[${j}]`;
        if (!isObject(test)) throw new MalformedReport(`${testWhere} is not an object`);
        const project = stringAt(test, 'projectName', testWhere);
        let status: Status = 'skip';
        if (!listing) {
          const raw = test.status;
          if (typeof raw !== 'string' || !Object.hasOwn(PLAYWRIGHT_STATUSES, raw)) {
            throw new MalformedReport(`${testWhere}.status is unknown: ${String(raw)}`);
          }
          if (!Array.isArray(test.results)) {
            throw new MalformedReport(`${testWhere}.results is not a list`);
          }
          status = PLAYWRIGHT_STATUSES[raw];
        }
        visit([project, ...path, title].join(' > '), status);
      });
    });
    arrayAt(suite, 'suites', where).forEach((child, i) => {
      const childWhere = `${where}.suites[${i}]`;
      if (!isObject(child)) throw new MalformedReport(`${childWhere} is not an object`);
      walk(child, [...path, stringAt(child, 'title', childWhere)], childWhere);
    });
  };
  // Top-level suites are files; their titles are not part of the check id.
  report.suites.forEach((fileSuite, i) => walk(fileSuite, [], `suites[${i}]`));
}

function readJson(file: string, set: ResultSet): unknown {
  const name = file.split('/').pop();
  if (!existsSync(file)) {
    set.problems.push(`${name} missing`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    set.problems.push(`${name} unreadable: ${(error as Error).message}`);
    return undefined;
  }
}

function isCheck(value: unknown): value is Check {
  const c = value as Check;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.id === 'string' &&
    (c.kind === 'assertion' || c.kind === 'fact') &&
    (c.status === 'pass' || c.status === 'fail' || c.status === 'skip')
  );
}

function addCheck(set: ResultSet, check: Check): void {
  if (set.checks.has(check.id)) set.problems.push(`duplicate check id ${check.id}`);
  set.checks.set(check.id, check);
}

function loadDeploy(dir: string, set: ResultSet): void {
  const deploy = readJson(join(dir, 'deploy.json'), set) as
    { target?: { digest?: string }; checks?: unknown } | undefined;
  if (deploy === undefined) return;
  if (!Array.isArray(deploy?.checks) || !deploy.checks.every(isCheck)) {
    set.problems.push('deploy.json malformed: checks must be a list of {id, kind, status}');
    return;
  }
  set.digest = deploy.target?.digest || undefined;
  for (const check of deploy.checks) addCheck(set, check);
}

function loadPlaywright(dir: string, set: ResultSet): void {
  const report = readJson(join(dir, 'playwright.json'), set);
  if (report === undefined) return;
  const checks: Check[] = [];
  const errors: string[] = [];
  try {
    walkPlaywright(report, false, (id, status) => checks.push({ id, kind: 'assertion', status }));
    for (const error of arrayAt(report as Record<string, unknown>, 'errors', 'report')) {
      const message = isObject(error) && typeof error.message === 'string' ? error.message : '';
      errors.push(message.split('\n')[0] || 'unknown error');
    }
  } catch (error) {
    if (!(error instanceof MalformedReport)) throw error;
    set.problems.push(`playwright.json malformed: ${error.message}`);
    return;
  }
  for (const error of errors) set.problems.push(`playwright run reported an error: ${error}`);
  for (const check of checks) addCheck(set, check);
  if (checks.length === 0) set.problems.push('playwright.json contains no tests');
}

export function loadResultSet(resultsDir: string, label: string): ResultSet {
  const set: ResultSet = { label, checks: new Map(), problems: [] };
  const dir = join(resultsDir, label);
  loadDeploy(dir, set);
  loadPlaywright(dir, set);
  return set;
}

/** Every test the suite defines, as check ids, from `playwright test --list`. */
export function listSuiteChecks(): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The JSON reporter must write to stdout, wherever the environment points it.
  delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  delete env.PLAYWRIGHT_JSON_OUTPUT_DIR;
  const output = execFileSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ids: string[] = [];
  walkPlaywright(JSON.parse(output), true, (id) => ids.push(id));
  if (ids.length === 0) throw new Error('the suite lists no tests');
  return ids;
}

export interface Comparison {
  verdict: Verdict;
  /** Which precedence rule decided the verdict (1, 2, 3 or 4). */
  decidedBy: 1 | 2 | 3 | 4;
  reasons: string[];
  regressions: string[];
  differences: string[];
  candidateOnlyFailures: string[];
  improvements: string[];
  failingOnBoth: string[];
  skippedOnBoth: string[];
}

function failed(set: ResultSet, id: string): boolean {
  return set.checks.get(id)?.status === 'fail';
}

/**
 * @param expected check ids every side must report; undefined when the suite
 *   could not be listed (that alone makes the comparison inconclusive).
 */
export function compare(
  baseline: ResultSet,
  candidate: ResultSet,
  expected: string[] | undefined
): Comparison {
  const result: Comparison = {
    verdict: 'PASS',
    decidedBy: 4,
    reasons: [],
    regressions: [],
    differences: [],
    candidateOnlyFailures: [],
    improvements: [],
    failingOnBoth: [],
    skippedOnBoth: [],
  };
  const required = new Set([...REQUIRED_DEPLOY_CHECKS, ...(expected ?? [])]);

  const ids = new Set([...required, ...baseline.checks.keys(), ...candidate.checks.keys()]);
  const kindMismatches: string[] = [];
  for (const id of [...ids].sort()) {
    const b = baseline.checks.get(id);
    const c = candidate.checks.get(id);
    if (b && c && b.kind !== c.kind) {
      kindMismatches.push(id);
      continue;
    }
    if ((b ?? c)?.kind === 'fact') continue;
    if (!b) {
      // Required on both sides: the baseline gap is handled under rule 2.
      if (c?.status === 'fail' && !required.has(id)) result.candidateOnlyFailures.push(id);
      continue;
    }
    if (b.status === 'pass' && (!c || c.status !== 'pass')) {
      result.regressions.push(id);
    } else if (b.status === 'pass' && c?.status === 'pass' && (b.value ?? '') !== (c.value ?? '')) {
      result.differences.push(id);
    } else if (b.status !== 'pass' && c?.status === 'pass') {
      result.improvements.push(id);
    } else if (b.status === 'fail' && c?.status === 'fail') {
      result.failingOnBoth.push(id);
    } else if (b.status === 'skip' && c?.status === 'skip') {
      result.skippedOnBoth.push(id);
    }
  }

  // 1. The candidate itself does not build or boot.
  const build = candidate.checks.get('deploy.build');
  if (build?.status === 'fail' && build.class === 'candidate-defect') {
    result.reasons.push('candidate build failed (candidate-defect)');
  }
  // Only when the baseline demonstrably became ready: otherwise (baseline not
  // ready, missing, or readiness recorded as a fact) rule 2 decides.
  const ready = candidate.checks.get('deploy.ready');
  const baselineReady = baseline.checks.get('deploy.ready');
  if (
    ready?.kind === 'assertion' &&
    ready.status === 'fail' &&
    !ready.class &&
    baselineReady?.kind === 'assertion' &&
    baselineReady.status === 'pass'
  ) {
    result.reasons.push(`candidate not ready: ${ready.detail ?? 'no detail'}`);
  }
  if (result.reasons.length > 0) {
    return { ...result, verdict: 'FAIL', decidedBy: 1 };
  }

  // 2. The comparison cannot be trusted.
  for (const id of ['deploy.build', 'deploy.ready']) {
    if (failed(baseline, id)) result.reasons.push(`baseline ${id} failed`);
  }
  if (expected === undefined) result.reasons.push('could not list the suite checks');
  for (const set of [baseline, candidate]) {
    for (const check of set.checks.values()) {
      if (check.status === 'fail' && (check.class === 'infra' || check.class === 'harness')) {
        result.reasons.push(`${set.label}: ${check.id} failed (${check.class})`);
      }
    }
    for (const problem of set.problems) result.reasons.push(`${set.label}: ${problem}`);
  }
  for (const id of required) {
    const b = baseline.checks.get(id);
    if (!b) result.reasons.push(`${baseline.label}: required check ${id} missing`);
    // Missing on the candidate after a baseline pass is a regression (rule 3);
    // after a baseline fail or skip there is nothing to compare against.
    if (b && b.status !== 'pass' && !candidate.checks.has(id)) {
      result.reasons.push(`${candidate.label}: required check ${id} missing`);
    }
    for (const set of [baseline, candidate]) {
      if (set.checks.get(id)?.kind === 'fact') {
        result.reasons.push(`${set.label}: required check ${id} is recorded as a fact`);
      }
    }
  }
  for (const id of kindMismatches) result.reasons.push(`check ${id} is a fact on one side only`);
  if (result.reasons.length > 0) {
    return { ...result, verdict: 'INCONCLUSIVE', decidedBy: 2 };
  }

  // 3 and 3a.
  if (result.regressions.length > 0) {
    result.reasons.push(`${result.regressions.length} new regression(s)`);
  }
  if (result.differences.length > 0) {
    result.reasons.push(`${result.differences.length} unacknowledged difference(s)`);
  }
  if (result.candidateOnlyFailures.length > 0) {
    result.reasons.push(`${result.candidateOnlyFailures.length} candidate-only failure(s)`);
  }
  return result.reasons.length > 0 ? { ...result, verdict: 'FAIL', decidedBy: 3 } : result;
}

function show(check: Check | undefined): string {
  if (!check) return 'missing';
  if (check.kind === 'fact') return check.value ? `\`${check.value}\`` : '-';
  const value = check.value !== undefined && check.value !== '' ? ` \`${check.value}\`` : '';
  return `${check.status}${value}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function list(title: string, ids: string[], baseline: ResultSet, candidate: ResultSet): string[] {
  if (ids.length === 0) return [`## ${title}`, '', 'None.', ''];
  return [
    `## ${title}`,
    '',
    ...ids.map((id) => {
      const c = candidate.checks.get(id);
      const detail = c?.detail ? ` - ${c.detail}` : '';
      return `- \`${id}\`: ${show(baseline.checks.get(id))} -> ${show(c)}${detail}`;
    }),
    '',
  ];
}

function matrix(sets: ResultSet[], kind: Kind): string[] {
  const ids = [
    ...new Set(
      sets.flatMap((s) => [...s.checks.values()].filter((c) => c.kind === kind).map((c) => c.id))
    ),
  ].sort();
  if (ids.length === 0) return ['None.', ''];
  return [
    `| Check | ${sets.map((s) => s.label).join(' | ')} |`,
    `|---|${sets.map(() => '---|').join('')}`,
    ...ids.map(
      (id) => `| \`${id}\` | ${sets.map((s) => cell(show(s.checks.get(id)))).join(' | ')} |`
    ),
    '',
  ];
}

export function renderReport(
  baseline: ResultSet | undefined,
  candidate: ResultSet,
  result?: Comparison
): string {
  const sets = baseline ? [baseline, candidate] : [candidate];
  const lines: string[] = ['# OpenBoxes compatibility report', ''];
  if (baseline && result) {
    lines.push(
      `**Verdict: ${result.verdict}** - baseline \`${baseline.label}\` vs candidate \`${candidate.label}\``,
      ''
    );
    if (result.reasons.length > 0) lines.push(...result.reasons.map((r) => `- ${r}`), '');
    if (result.decidedBy <= 2) {
      lines.push(
        `The verdict was decided by precedence rule ${result.decidedBy}; the check differences below are informational.`,
        ''
      );
    }
    lines.push(
      ...list('New regressions', result.regressions, baseline, candidate),
      ...list('Unacknowledged differences', result.differences, baseline, candidate),
      ...list('Candidate-only failures', result.candidateOnlyFailures, baseline, candidate),
      ...list('Failing on both', result.failingOnBoth, baseline, candidate),
      ...list('Fixed on the candidate', result.improvements, baseline, candidate)
    );
    if (result.skippedOnBoth.length > 0) {
      lines.push(...list('Skipped on both', result.skippedOnBoth, baseline, candidate));
    }
  } else {
    lines.push(`Single target \`${candidate.label}\`: facts only, no verdict.`, '');
    if (candidate.problems.length > 0) lines.push(...candidate.problems.map((p) => `- ${p}`), '');
  }
  lines.push('## Targets', '');
  for (const set of sets) {
    lines.push(`- \`${set.label}\`: ${set.digest ? `\`${set.digest}\`` : 'no image digest'}`);
  }
  lines.push('', '## Checks', '', ...matrix(sets, 'assertion'));
  lines.push('## Facts (recorded, not compared)', '', ...matrix(sets, 'fact'));
  return lines.join('\n');
}

export function main(args: string[] = process.argv.slice(2)): number {
  let values: { baseline?: string; candidate?: string; results?: string; out?: string } = {};
  try {
    ({ values } = parseArgs({
      args,
      options: {
        baseline: { type: 'string' },
        candidate: { type: 'string' },
        results: { type: 'string', default: 'results' },
        out: { type: 'string' },
      },
    }));
  } catch (error) {
    console.error((error as Error).message);
  }
  if (!values.candidate) {
    console.error(
      'usage: compare.ts [--baseline <label>] --candidate <label> [--results <dir>] [--out <dir>]'
    );
    return 3;
  }
  const resultsDir = values.results ?? 'results';
  const candidate = loadResultSet(resultsDir, values.candidate);
  const baseline = values.baseline ? loadResultSet(resultsDir, values.baseline) : undefined;
  let expected: string[] | undefined;
  if (baseline) {
    try {
      expected = listSuiteChecks();
    } catch (error) {
      console.error(`could not list the suite checks: ${(error as Error).message}`);
    }
  }
  const result = baseline ? compare(baseline, candidate, expected) : undefined;

  const out =
    values.out ??
    join(
      resultsDir,
      'compare',
      baseline ? `${baseline.label}..${candidate.label}` : candidate.label
    );
  mkdirSync(out, { recursive: true });
  const markdown = renderReport(baseline, candidate, result);
  writeFileSync(join(out, 'compat-report.md'), `${markdown}\n`);
  writeFileSync(
    join(out, 'compare.json'),
    `${JSON.stringify({ baseline: baseline?.label, candidate: candidate.label, ...(result ?? {}) }, null, 2)}\n`
  );
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  if (!result) return 0;
  return { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 }[result.verdict];
}

if (require.main === module) process.exitCode = main();
