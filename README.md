# openboxes-compatibility

Black-box checks that show whether a dependency upgrade or release broke OpenBoxes functionality, deployments. Also includes API compatibility tests to ensure we don't introduce breaking changes.

## How it works

The suite runs the same checks against two running OpenBoxes instances and compares the results:

- **Baseline** - the known-good build (for an upgrade branch: its merge-base with `develop`; for the quick lane: release `v0.9.8`).
- **Candidate** - the build under test (an upgrade branch, or release `v0.9.9` in the quick lane).

Each side runs in its own **lane**: boot the image with its own database, record deployment checks, run the API and page checks, and write `results/<label>/`. **Compare** then reads both result sets and decides a verdict:

1. The candidate does not build, or - while the baseline did become ready - its app container does not start, stops, does not become ready, or stops answering before the tests -> **FAIL**.
2. The baseline does not boot (so neither side ready is inconclusive too), an infrastructure or harness error occurred (image pull, database or mail down, ports, Compose), a result file is missing, malformed or reports a run error, a check the suite defines is missing where it cannot be compared, or a required assertion is recorded as a fact -> **INCONCLUSIVE**.
3. A check that passes on the baseline fails, is skipped or is missing on the candidate (a new regression), or a compared value differs -> **FAIL**. A failing check that exists only on the candidate -> **FAIL**.
4. Otherwise -> **PASS**.

Deployment output is split in two. **Compared assertions** take part in the verdict: readiness (the login page answers 200), the health endpoint path, the Java major version, and a boot log free of errors (an allowlist comes with the full deployment checks). **Recorded facts** appear in the report but never change the verdict: image digest, full `java -version`, effective `JAVA_TOOL_OPTIONS`, and time to ready.

The suite never branches on the target: it only reads the environment described in `.env.example`, so it also runs against any existing instance.

## What is covered so far

- Deployment: boot a published image with MariaDB 10.3.39 and Mailpit; readiness, health path, Java version, `JAVA_TOOL_OPTIONS` (the image default plus the suite's mail flags, appended), boot log scan.
- API: `GET /api/getAppContext` answers 200 with a JSON content type and a body that parses as JSON (response shapes are not compared yet).
- Pages: the dashboard settles after an API login (configurations listed, number cards shown, no loading placeholders left) with no uncaught page errors and no console errors from the app's own origin (console errors from other origins are recorded as test annotations).
- Compare: the checks every side must report are the required deployment assertions plus every test the suite defines (`playwright test --list`); unit tests in `scripts/compare.test.ts` (`npm run test:unit`).
- CI (`.github/workflows/ci.yml`, actions pinned by commit SHA): lint, typecheck, shellcheck, compare unit tests, and the quick lane `v0.9.8` -> `v0.9.9` with both images pinned by digest. No secrets are used, so pull requests from forks run everything; results and the report are uploaded as artifacts.

Building images from a git SHA, more deployment scenarios, API shape snapshots, page smoke over all routes, business flows, and mail and job checks come later.

## Running locally

Requirements: Docker with Compose v2, Node 22 (`nvm use`), `curl` and `jq`. Published images are `linux/amd64`; on Apple silicon they run under emulation and take a few minutes to boot.

```sh
npm ci
npx playwright install chromium

# Baseline
scripts/stack.sh up image-v0.9.8 ghcr.io/openboxes/openboxes:v0.9.8
scripts/stack.sh check image-v0.9.8 && OB_LABEL=image-v0.9.8 npx playwright test
scripts/stack.sh down image-v0.9.8

# Candidate
scripts/stack.sh up image-v0.9.9 ghcr.io/openboxes/openboxes:v0.9.9
scripts/stack.sh check image-v0.9.9 && OB_LABEL=image-v0.9.9 npx playwright test
scripts/stack.sh down image-v0.9.9

# Verdict and report (results/compare/image-v0.9.8..image-v0.9.9/compat-report.md)
npm run compare -- --baseline image-v0.9.8 --candidate image-v0.9.9
```

`stack.sh up` empties `results/<label>/` first, refuses to start when a host port is taken, requires the app to keep answering for `OB_STABILITY_SECONDS` (default 15) after its first answer, and removes the stack again when it fails (`OB_KEEP_STACK=1` keeps it for debugging). Labels use `[a-z0-9.-]`; each label gets its own Compose project and database volume. If port 8080 or 8025 is taken, set `OB_HTTP_PORT` / `OB_MAILPIT_PORT` for `stack.sh` and the matching `OB_BASE_URL` for Playwright, e.g. `OB_HTTP_PORT=18080` and `OB_BASE_URL=http://localhost:18080/openboxes`.

Against an existing instance, skip `stack.sh`: set `OB_BASE_URL`, the admin credentials and `OB_LABEL` (see `.env.example`), run `npx playwright test`, then `npm run compare -- --candidate <label>` for a facts-only report without a verdict.

`npm run lint`, `npm run typecheck` and `npm run test:unit` run the static checks and the compare unit tests.
