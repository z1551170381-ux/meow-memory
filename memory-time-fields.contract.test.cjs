'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiDir = path.join(__dirname, 'functions', 'api');
const recall = fs.readFileSync(path.join(apiDir, 'recall.js'), 'utf8');
const batch = fs.readFileSync(path.join(apiDir, 'memory-batch.js'), 'utf8');
const bundle = fs.readFileSync(path.join(apiDir, 'recall-bundle.js'), 'utf8');

assert.match(recall, /sbSelectMemoriesByIds/);
assert.match(recall, /metadata\.happened_at \|\| metadata\.manual_date \|\| metadata\.message_at/);
assert.match(recall, /time_needs_review:/);
assert.match(recall, /source_id: metadata\.source_local_id \|\| metadata\.source_id/);
assert.match(recall, /source_url: metadata\.source_url/);
assert.match(recall, /created_at: row\.created_at \|\| r\.created_at/);
assert.match(bundle, /time_kind: m\.happened_at_kind/);
assert.match(bundle, /time_needs_review: m\.time_needs_review === true/);
assert.match(batch, /metadata: \{ \.\.\.\(existing\.metadata \|\| \{\}\), \.\.\.metadata \}/,
  '按 source_id 更新旧云端记忆时必须保留家人终审等既有 metadata');

console.log('memory time fields cloud contract: 9 assertions passed');
