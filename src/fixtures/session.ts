import { type APIRequestContext, expect, type Page, test as base } from '@playwright/test';

import { env } from '../config/env';

/** Log in through the API and choose the configured location. */
export async function login(request: APIRequestContext): Promise<void> {
  const response = await request.post('api/login', {
    data: {
      username: env.adminUsername,
      password: env.adminPassword,
      location: env.locationId,
    },
  });
  expect(response.status(), 'POST api/login').toBe(200);
}

interface SessionFixtures {
  /** API client with an authenticated admin session at the configured location. */
  api: APIRequestContext;
  /** Browser page whose context carries an authenticated admin session. */
  authedPage: Page;
}

export const test = base.extend<SessionFixtures>({
  // The built-in request fixture honors the config's `use` options (baseURL,
  // extraHTTPHeaders, ignoreHTTPSErrors, ...).
  api: async ({ request }, use) => {
    await login(request);
    await use(request);
  },
  authedPage: async ({ page }, use) => {
    // page.request shares the browser context's cookie jar.
    await login(page.request);
    await use(page);
  },
});

export { expect };
