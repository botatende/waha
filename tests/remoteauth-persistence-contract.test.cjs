const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const remoteAuthPath = path.resolve(
  __dirname,
  '../koolaber-overlay/core/engines/webjs/RemoteAuth.js',
);
const source = fs.readFileSync(remoteAuthPath, 'utf8');

test('REMOTE_SESSION_SAVED is emitted only after confirmed persistence', () => {
  assert.match(source, /const persisted = await this\.ensureInitialBackup\(\)/);
  assert.match(source, /if \(persisted\) \{\s*this\.client\.emit/);
  assert.match(source, /blob nao confirmado no store/);
});

test('store save is verified and non-SessionOpClosed errors propagate', () => {
  assert.match(source, /await this\.store\.save\(\{ session: this\.sessionName \}\)/);
  assert.match(source, /await this\.store\.sessionExists/);
  assert.match(source, /RemoteAuth blob was not confirmed in the store/);
  assert.match(source, /this\.logger\.error\(e, 'backup sync error'\);\s*throw e/);
});

test('destroy performs a fresh final backup instead of reusing initial promise', () => {
  const destroyStart = source.indexOf('async destroy()');
  const destroyEnd = source.indexOf('async disconnect()', destroyStart);
  const destroyBody = source.slice(destroyStart, destroyEnd);
  assert.ok(destroyStart >= 0 && destroyEnd > destroyStart, 'destroy body must exist');
  assert.match(destroyBody, /this\.storeRemoteSession\(\)/);
  assert.doesNotMatch(destroyBody, /this\.ensureInitialBackup\(\)/);
});

test('failed initial backup resets single-flight for a real retry', () => {
  assert.match(source, /if \(!confirmed && this\.initialBackupPromise === backupPromise\)/);
  assert.match(source, /this\.initialBackupPromise = null/);
});
