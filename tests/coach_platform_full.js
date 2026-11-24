// Coach Platform - the WHOLE Edge Function (every endpoint, the router and the tenant scope) on the in-memory database
// from coach_platform_fixture.js. Used by the sandbox so the real coach dashboard can run against real handler code.
// Sandbox only: nothing here is a production credential and nothing leaves the machine.
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const FX = require('./coach_platform_fixture.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/api/index.ts'), 'utf8')
  .replace(/^import .*$/gm, '');
const js = ts.transpileModule(SRC, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let handler = null;
const ENV = { SUPABASE_URL: 'http://sandbox.invalid', SUPABASE_SERVICE_ROLE_KEY: 'sandbox', COACH_PASSWORD_HASH: FX.OMAR_HASH, CP_BUILDER_KEY_SHA256: FX.BUILDER_KEY_SHA };
const Deno = { env: { get: (k) => (process.env['SBX_' + k] !== undefined ? process.env['SBX_' + k] : ENV[k]) }, serve: (h) => { handler = h; } };
const createClient = () => FX.rawAdmin;
new Function('createClient', 'AsyncLocalStorage', 'Deno', js)(createClient, AsyncLocalStorage, Deno);
if (!handler) throw new Error('the Edge Function did not register a handler');
/** POST one request body through the real router. Returns the parsed JSON answer. */
async function call(body) {
  const res = await handler(new Request('http://sandbox.invalid/api', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }));
  return res.json();
}
module.exports = { call, DB: FX.DB, FX };
