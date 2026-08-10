#!/usr/bin/env node
/**
 * One-time helper: turn a Chrome Web Store OAuth client into a refresh token,
 * and (optionally) push all three values straight into GitHub Actions secrets.
 *
 * The refresh token is the awkward part of the Chrome Web Store API: it is only
 * ever returned once, on the first consent, and only when the request asks for
 * offline access. Google also removed the old copy-paste "oob" flow, so a real
 * loopback redirect is required — which is all this script is.
 *
 * Usage:
 *   node scripts/cws-auth.mjs                    # prints the three values
 *   node scripts/cws-auth.mjs --set-secrets      # also runs `gh secret set`
 *
 * Prompts for the client id/secret rather than taking them as argv so they do not
 * land in your shell history.
 */
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';

const PORT = 8818;
const REDIRECT = `http://127.0.0.1:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const SET_SECRETS = process.argv.includes('--set-secrets');

/** Env wins over prompting, so this can run unattended. Prompting is the path for
 *  humans: it keeps the values out of shell history. */
let clientId = (process.env.CWS_CLIENT_ID ?? '').trim();
let clientSecret = (process.env.CWS_CLIENT_SECRET ?? '').trim();

if (!clientId || !clientSecret) {
  if (!stdin.isTTY) {
    console.error('Set CWS_CLIENT_ID and CWS_CLIENT_SECRET in the environment, or run this from a terminal.');
    process.exit(1);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  clientId ||= (await rl.question('Client ID: ')).trim();
  clientSecret ||= (await rl.question('Client secret: ')).trim();
  rl.close();
}

if (!clientId || !clientSecret) {
  console.error('Both values are required.');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  // Without BOTH of these Google returns an access token and no refresh token —
  // and `prompt=consent` is what makes it re-issue one on a repeat run.
  access_type: 'offline',
  prompt: 'consent',
});

/** Wait for Google to redirect back with ?code=… */
const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    const c = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">
      <h2>${c ? 'Authorised — you can close this tab.' : 'Authorisation failed'}</h2>
      <p>${c ? 'Back to your terminal.' : String(err ?? 'no code returned')}</p></body>`);
    server.close();
    c ? resolve(c) : reject(new Error(err ?? 'no code returned'));
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nListening on ${REDIRECT}\nOpening your browser — approve with the account that owns the listing.\n`);
    console.log(`If it does not open, paste this:\n${authUrl}\n`);
    const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(open, [authUrl], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  });
  setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes')); }, 300000).unref();
});

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
});
const tok = await res.json();

if (!tok.refresh_token) {
  console.error('\nNo refresh_token came back:', JSON.stringify(tok, null, 2));
  console.error('\nUsually means this client has been authorised before. Revoke it at');
  console.error('https://myaccount.google.com/permissions and run again.');
  process.exit(1);
}

if (SET_SECRETS) {
  const repo = 'cmaftuleac/claude-code-browser';
  for (const [name, value] of [
    ['CWS_CLIENT_ID', clientId],
    ['CWS_CLIENT_SECRET', clientSecret],
    ['CWS_REFRESH_TOKEN', tok.refresh_token],
  ]) {
    // Value goes in on stdin so it never appears in argv or shell history.
    execFileSync('gh', ['secret', 'set', name, '--repo', repo], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    console.log(`  set ${name}`);
  }
  console.log('\nDone — all three secrets are in GitHub.');
} else {
  console.log('\nAdd these as GitHub Actions secrets:\n');
  console.log(`CWS_CLIENT_ID      ${clientId}`);
  console.log(`CWS_CLIENT_SECRET  ${clientSecret}`);
  console.log(`CWS_REFRESH_TOKEN  ${tok.refresh_token}`);
  console.log('\nOr re-run with --set-secrets to have gh do it for you.');
}
