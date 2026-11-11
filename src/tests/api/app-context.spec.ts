import { expect, test } from '../../fixtures/session';

// Status, content type, and a body that parses as JSON. The response shape is
// not compared yet: v0.9.9 adds keys to getAppContext, so a shape check needs
// acknowledged expectations, which arrive with the API contract layer.
test('getAppContext answers JSON', async ({ api }) => {
  const response = await api.get('api/getAppContext');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^application\/json\b/);
  await expect(response.json()).resolves.toBeDefined();
});
