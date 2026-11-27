/* eslint-disable no-console */
// Sends an FCM (HTTP v1) notification to a topic. No npm packages needed.
//
// Push (automatic): runs when daily/index.json changes. It only sends if a
// date was ADDED in this push and that date is today (India time), so fixing
// a typo or re-uploading never spams students.
// Manual: "Run workflow" in GitHub Actions with your own title/body/topic.
//
// Needs repo secret FCM_SERVICE_ACCOUNT = the full JSON of a Firebase service
// account key (Firebase console → Project settings → Service accounts →
// Generate new private key).

const crypto = require('crypto');
const fs = require('fs');
const {execSync} = require('child_process');

const todayIST = () => {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

const readIndexAt = rev => {
  try {
    return JSON.parse(execSync(`git show ${rev}:daily/index.json`, {encoding: 'utf8'}));
  } catch (e) {
    return [];
  }
};

const b64url = buf =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const accessToken = async sa => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(sa.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${b64url(sig)}`,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`OAuth failed: ${JSON.stringify(json)}`);
  return json.access_token;
};

const main = async () => {
  if (!process.env.FCM_SERVICE_ACCOUNT) {
    console.error('Missing secret FCM_SERVICE_ACCOUNT');
    process.exit(1);
  }
  const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT);
  const manual = process.env.EVENT_NAME === 'workflow_dispatch';
  const today = todayIST();

  let title = process.env.INPUT_TITLE || '';
  let body = process.env.INPUT_BODY || '';
  const topic = (manual && process.env.INPUT_TOPIC) || 'daily_dose';
  const route = (manual && process.env.INPUT_ROUTE) || 'DailyDose';

  if (!manual) {
    const before = new Set(readIndexAt('HEAD~1'));
    const after = readIndexAt('HEAD');
    const added = after.filter(d => !before.has(d));
    console.log('Dates added in this push:', added);
    if (!added.includes(today)) {
      console.log(`Today's date (${today}) was not newly added — no notification sent.`);
      return;
    }
    let count = 10;
    try {
      const day = JSON.parse(fs.readFileSync(`daily/${today}.json`, 'utf8'));
      const qs = Array.isArray(day) ? day : day.questions || [];
      if (qs.length) count = qs.length;
    } catch (e) {}
    title = '🎯 Today\'s Daily Dose is live!';
    body = `${count} fresh JEE questions are waiting. Can you get them all right? 🔥`;
  }
  if (!title) title = '🎯 Daily Dose';

  const token = await accessToken(sa);
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        message: {
          topic,
          notification: {title, body},
          data: {route, date: today},
          android: {
            priority: 'HIGH',
            notification: {channel_id: route === 'DailyDose' ? 'daily-dose' : 'default'},
          },
          apns: {payload: {aps: {sound: 'default'}}},
        },
      }),
    },
  );
  const out = await res.text();
  console.log(res.status, out);
  if (!res.ok) process.exit(1);
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
