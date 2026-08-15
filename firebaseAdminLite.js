// A minimal, dependency-light replacement for the parts of firebase-admin we
// actually need (generate password-reset and email-verification links).
//
// The full `firebase-admin` npm package pulls in Firestore, Cloud Storage,
// google-gax, protobufjs and friends - a huge dependency tree that blew past
// Vercel's serverless function bundle size and crashed the ENTIRE server on
// cold start (every route, not just the new one). That was a production
// incident. This file talks to the same underlying Google API directly:
//
//   1. Sign a short-lived JWT with the service account's private key
//      (RS256, via the `jsonwebtoken` package we already depend on).
//   2. Exchange it for a Google OAuth2 access token.
//   3. Call the Identity Toolkit REST API's accounts:sendOobCode with
//      returnOobLink: true - this is the exact same endpoint
//      admin.auth().generatePasswordResetLink() calls internally, so the
//      resulting link is identical in form and behavior.
//
// No new heavy dependencies - just jsonwebtoken + native fetch.
const jwt = require("jsonwebtoken");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const IDENTITY_TOOLKIT_SCOPE = "https://www.googleapis.com/auth/identitytoolkit";

async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
      scope: IDENTITY_TOOLKIT_SCOPE,
    },
    serviceAccount.private_key,
    { algorithm: "RS256" }
  );

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Failed to get Google access token: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.access_token;
}

// Returns { generatePasswordResetLink(email), generateEmailVerificationLink(email) }
// bound to this service account.
function initFirebaseAdminLite(serviceAccount) {
  async function sendOobCode(requestType, email) {
    const accessToken = await getGoogleAccessToken(serviceAccount);
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${serviceAccount.project_id}/accounts:sendOobCode`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ requestType, email, returnOobLink: true }),
      }
    );
    const data = await res.json();
    if (!data.oobLink) {
      throw new Error(data.error?.message || `Failed to generate ${requestType} link: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data.oobLink;
  }

  return {
    generatePasswordResetLink: (email) => sendOobCode("PASSWORD_RESET", email),
    generateEmailVerificationLink: (email) => sendOobCode("VERIFY_EMAIL", email),
  };
}

module.exports = { initFirebaseAdminLite };
