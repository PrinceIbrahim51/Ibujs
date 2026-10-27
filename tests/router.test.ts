import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, createRouter } from '../packages/ui/src/router.js';
test('route parameters and matching', () => {
  assert.deepEqual(matchRoute('/users/:id', '/users/hello%20world'), { id: 'hello world' });
  assert.equal(matchRoute('/users/:id', '/users'), null);
  assert.equal(matchRoute('/users/:id', '/other/1'), null);
  assert.equal(matchRoute('/users/:id', '/users/%ZZ'), null);
});
test('router supports server-side default path', () => {
  const router = createRouter([{path:'/', component: () => 'Home'}]);
  assert.equal(router.view(), 'Home');
  router.dispose();
});
