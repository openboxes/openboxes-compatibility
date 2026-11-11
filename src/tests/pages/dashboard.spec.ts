import { env } from '../../config/env';
import { expect, test } from '../../fixtures/session';

test('dashboard renders', async ({ authedPage: page }) => {
  // Uncaught exceptions and console errors raised by the app's own origin are
  // the failure signal: the React app has no error boundary on this page, so a
  // broken widget shows only here. Console errors from other origins (the
  // layout loads CDN resources) are recorded as annotations, not failures.
  const appOrigin = new URL(env.baseUrl).origin;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const source = message.location().url;
    let origin = appOrigin;
    try {
      if (source) origin = new URL(source).origin;
    } catch {
      // Not a URL (e.g. "debugger eval code"): treat as the app's own.
    }
    if (origin === appOrigin) {
      errors.push(`console: ${message.text()}`);
    } else {
      test.info().annotations.push({
        type: 'foreign-console-error',
        description: `${source}: ${message.text()}`,
      });
    }
  });

  const response = await page.goto('dashboard/index');
  expect(response?.status()).toBe(200);
  await expect(page).not.toHaveURL(/\/auth\/login\b/);

  // Settled dashboard: the dashboard configurations are listed, the number
  // cards are present, and every loading placeholder (.loader-div) is gone.
  const dashboard = page.locator('.dashboard-container');
  await expect(dashboard.locator('.configs-list-item').first()).toBeAttached({ timeout: 45_000 });
  await expect(dashboard.locator('.cards-container .number-card').first()).toBeVisible();
  await expect(dashboard.locator('.loader-div')).toHaveCount(0, { timeout: 45_000 });

  await page.screenshot({ path: test.info().outputPath('dashboard.png'), fullPage: true });
  expect(errors, 'page errors and console errors from the app origin').toEqual([]);
});
