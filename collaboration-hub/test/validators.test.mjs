import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, checkLength, cleanText, cleanFieldList, fieldNameError, isValidRole, isValidStatus } from '../src/utils/validators.mjs';
import { redactSecrets } from '../src/utils/formatters.mjs';

test('checkLength rejects text over the limit instead of cutting it', () => {
  assert.deepEqual(checkLength('  Samija  ', 'name', 'Name'), { value: 'Samija' });
  assert.deepEqual(checkLength('x'.repeat(LIMITS.name), 'name', 'Name'), { value: 'x'.repeat(40) });
  assert.match(checkLength('x'.repeat(41), 'name', 'Name').error, /Name must be 40 characters or fewer \(got 41\)/);
  assert.deepEqual(checkLength(undefined, 'note', 'Message'), { value: '' });
});

test('cleanText trims and cuts; non-strings become empty', () => {
  assert.equal(cleanText('  abc  ', 2), 'ab');
  assert.equal(cleanText(42, 10), '');
});

test('field names, roles and statuses', () => {
  assert.deepEqual(cleanFieldList([' name ', '', 7, 'desc']), ['name', 'desc']);
  assert.equal(cleanFieldList('name').length, 0);
  assert.equal(fieldNameError('a:b'), 'Field names cannot contain ":"');
  assert.equal(fieldNameError('description'), null);
  assert.ok(isValidRole('developer'));
  assert.ok(!isValidRole('<script>'));
  assert.ok(isValidStatus('done'));
  assert.ok(!isValidStatus('finished'));
});

test('limits cannot be changed at runtime', () => {
  assert.ok(Object.isFrozen(LIMITS));
});

test('redactSecrets hides Trello key and token', () => {
  assert.equal(redactSecrets('GET /1/cards?key=abc&token=xyz failed'), 'GET /1/cards?key=[redacted]&token=[redacted] failed');
});
