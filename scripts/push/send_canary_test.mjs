#!/usr/bin/env node
// Sends the fixed `test` notification to `_push_canary` via coachPushSend.
//
//   node scripts/push/send_canary_test.mjs                    # new request
//   node scripts/push/send_canary_test.mjs --request-id <id>  # repeat an id → proves dedupe (no 2nd push)
//
// Cost: 1 `push` invocation. Prints event status and per-device outcome only
// (device id, push host, HTTP status) — never endpoints or keys.
import { randomBytes } from 'node:crypto';
import { CANARY_KEY, coachToken, post } from './common.mjs';

const i = process.argv.indexOf('--request-id');
const requestId = i > 0 ? process.argv[i + 1] : `canary_${Date.now()}_${randomBytes(4).toString('hex')}`;

const ct = await coachToken();
const { status, j } = await post('push', {
  type: 'coachPushSend', coachToken: ct, storageKey: CANARY_KEY, template: 'test', requestId,
});
console.log(`HTTP ${status}  requestId=${requestId}`);
console.log(JSON.stringify(j, null, 2));
process.exit(j && j.ok === true ? 0 : 1);
