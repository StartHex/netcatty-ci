import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DATABASE_ENCODINGS,
  ON_HOST_AUTO_ENCODING,
  currentDatabaseEncoding,
  databaseEncodingChoices,
  supportsClientEncoding,
} from './encoding.ts';

test('only drivers with a client-side charset offer one', () => {
  for (const kind of ['mysql', 'mariadb', 'jdbc', 'onhost'] as const) {
    assert.equal(supportsClientEncoding(kind), true, kind);
  }
  for (const kind of ['postgresql', 'oracle', 'sqlserver', 'sqlite'] as const) {
    assert.equal(supportsClientEncoding(kind), false, kind);
    assert.equal(currentDatabaseEncoding(kind, 'gbk'), null, kind);
  }
});

test('the default shown is what the driver does when nothing is chosen', () => {
  assert.equal(currentDatabaseEncoding('mysql'), 'utf8mb4');
  assert.equal(currentDatabaseEncoding('jdbc', '  '), 'utf8mb4');
  // The on-host driver decides by the host's locale instead.
  assert.equal(currentDatabaseEncoding('onhost'), ON_HOST_AUTO_ENCODING);
  assert.equal(currentDatabaseEncoding('onhost', ''), ON_HOST_AUTO_ENCODING);
});

test('an explicit choice is shown as chosen', () => {
  assert.equal(currentDatabaseEncoding('mysql', ' gbk '), 'gbk');
  assert.equal(currentDatabaseEncoding('onhost', 'gb18030'), 'gb18030');
  assert.equal(currentDatabaseEncoding('onhost', ON_HOST_AUTO_ENCODING), ON_HOST_AUTO_ENCODING);
});

test('the on-host driver offers Python codec names, not MySQL charset names', () => {
  const choices = databaseEncodingChoices('onhost');
  assert.deepEqual([...choices], ['utf8', 'gbk', 'gb18030', 'big5', 'latin1']);
  assert.equal(choices.includes('utf8mb4'), false);
  assert.equal(choices.includes(ON_HOST_AUTO_ENCODING), false, 'automatic is the default entry, not a charset');
  assert.deepEqual([...databaseEncodingChoices('mysql')], [...DATABASE_ENCODINGS]);
  assert.deepEqual([...databaseEncodingChoices('jdbc')], [...DATABASE_ENCODINGS]);
});
