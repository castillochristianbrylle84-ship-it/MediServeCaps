# Deploy the Admin app separately on Netlify

The project now builds the Admin Dashboard as a Vite single-page application. Customer pages and API routes remain in the existing Next.js deployment. Admin queue and inventory subscriptions continue to connect directly to the same Firebase project, so updates remain real-time without routing Firestore traffic through the Customer host. HTTP API calls (including SMS) use `VITE_API_BASE_URL`.

## Netlify setup

1. Push this repository to the Git provider connected to Netlify and create a new site from it. Use the repository root as the Base directory; the root `netlify.toml` configures the Admin build. Do not enable `@netlify/plugin-nextjs` on this static Admin site.
2. Set Build command to `npm run build:admin` and Publish directory to `admin/dist`. Node 22 is pinned in `netlify.toml`.
3. Add these variables under **Site configuration → Environment variables**. Use the exact production URLs and Firebase web app values:

   - `VITE_API_BASE_URL`: absolute origin of the deployed Next.js Customer/backend app, for example `https://app.example.com` (no trailing slash).
   - `VITE_CUSTOMER_URL`: customer portal URL, for example `https://app.example.com/customer`.
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
   - `VITE_FIREBASE_MEASUREMENT_ID` (optional)

   The matching placeholder list is in `admin/.env.example`. These are Firebase web configuration values, not service-account credentials. Never put `FIREBASE_ADMIN_PRIVATE_KEY`, `IPROGSMS_API_KEY`, or `OTP_HASH_SECRET` in the Netlify Admin site's variables.
4. Trigger a deploy. The SPA fallback in `netlify.toml` serves the Admin entry point on refresh/deep links.
5. Add the Netlify hostname to Firebase Authentication's **Authorized domains**. For a custom domain, add `admin.example.com` too. Firebase Auth persists the user's session on the Admin origin; it is not shared with the Customer origin.
6. Configure `CORS_ALLOWED_ORIGINS` on the Next.js backend deployment to the comma-separated cross-origin browser origins, for example `https://admin-app.netlify.app,https://customer.example.com`. Same-origin requests are allowed automatically. Include the actual Customer frontend origin when it is hosted separately from the API, plus local development origins when needed. The API normalizes a trailing slash but does not allow paths or wildcards. Redeploy/restart the backend after changing it.
7. On Firebase, grant `admin: true` as a custom claim only to Admin users. Do this from a trusted server or admin workstation with the Firebase Admin SDK, not from the browser. Example for a one-off trusted Node script:

   ```js
   const { initializeApp, applicationDefault } = require("firebase-admin/app");
   const { getAuth } = require("firebase-admin/auth");

   initializeApp({ credential: applicationDefault(), projectId: "your-project-id" });
   await getAuth().setCustomUserClaims("FIREBASE_USER_UID", { admin: true });
   ```

   The user must sign out and back in (or refresh their ID token) for updated claims to appear. Admin UI checks this claim, and `POST /api/sms` independently verifies the Firebase ID token and claim on the backend.

## Secrets scanning and credential safety

The Admin build reads `VITE_*` variables, with the matching `NEXT_PUBLIC_*` variables as fallbacks. These values are intentionally included in browser JavaScript. The root `netlify.toml` excludes only the documented public Firebase web configuration and public application URLs from environment-value scanning using `SECRETS_SCAN_OMIT_KEYS` under `[build.environment]`. Secret scanning remains enabled for all other variables and files. Never add service-account private keys, SMS tokens, or OTP secrets to this list or to client-side configuration.

Local `.env*` files are ignored, except for placeholder `.env.example` templates. Set real values in the deployment host's environment settings rather than source files or documentation. Firebase web API keys are public project identifiers, not authorization credentials; enforce Firebase Security Rules and appropriate API restrictions.

A Firebase service-account private key and an SMS API token were previously hardcoded in the shared client module and have been removed. Treat those credentials as compromised: revoke the exposed service-account key, rotate the SMS token, and update only the backend host's environment settings. Removing them from the current files does not remove them from Git history or previously published assets. Check prior deployments and coordinate repository-history cleanup where needed.

See the Netlify secrets-scanning documentation at https://docs.netlify.com/build/environment-variables/secrets-controller/ and Firebase API key guidance at https://firebase.google.com/docs/projects/api-keys.

## Backend environment

Set the following on the Next.js Customer/backend host, not on the static Admin site:

```env
CORS_ALLOWED_ORIGINS=https://admin-app.netlify.app,https://app.example.com
NEXT_PUBLIC_API_URL=https://app.example.com
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
FIREBASE_ADMIN_PROJECT_ID=...
FIREBASE_ADMIN_CLIENT_EMAIL=...
FIREBASE_ADMIN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
IPROGSMS_API_KEY=...
OTP_HASH_SECRET=...
```

The root `.env.example` is the Next.js backend template. Keep all private backend values in the backend host's secret environment settings. The iProgSMS API token is sent server-side to `https://www.iprogsms.com/api/v1/sms_messages` as `api_token`, alongside `phone_number` and `message`; the optional `sms_provider` uses the provider default. Configure the sender identity in the iProgSMS account.

## CORS and auth behavior

Cross-origin API calls use `Authorization: Bearer <Firebase ID token>`, not cookies. The backend explicitly handles `OPTIONS`, allows only configured origins, and permits `Authorization` and `Content-Type` headers. It does not enable `Access-Control-Allow-Credentials`; cookies are not used, so browser requests must not use `credentials: "include"`. HTTPS is required in production for both sites and API.

OTP send/verify routes are customer-facing and use the same CORS origin allowlist and phone-number rate limits, but do not require Admin claims. They are used before a customer can submit queue registration; Admin login does not use SMS or OTP verification. The SMS notification route requires a verified Admin claim. Do not proxy privileged API secrets into Netlify's static build; the Admin's `VITE_*` values are embedded in browser code.

## Realtime and data security note

Firestore realtime listeners run from the Admin browser directly to Firebase, not through the API host, so CORS on the Next.js API does not control them. Firebase Authentication domain authorization and Firestore Security Rules apply. The current Customer app also reads and writes Firestore directly and subscribes to the shared customer collection; restricting that collection to Admin-only would break Customer queue registration/tracking. Treat customer collection data as exposed to any identity permitted by the current Firestore rules, and plan a separate authenticated customer API/limited per-customer read model before tightening those rules. Admin UI role checks alone are not a replacement for Firestore rules.

There is no WebSocket/Socket.IO server in this project; Firestore provides the live updates. Use HTTPS for both deployments, for example `admin.example.com` and `app.example.com`; do not rely on cross-subdomain cookies because this deployment uses Firebase Auth tokens instead.

## Deploying the Next.js Customer/API app on Netlify

The repository root `netlify.toml` is reserved for the standalone Vite Admin site and publishes `admin/dist`. For a separate Netlify site hosting the Next.js Customer app and API routes, keep the repository root as the Base directory and set the Netlify configuration file path to `netlify.nextjs.toml`. That config runs `npm run build`, publishes `.next`, and enables `@netlify/plugin-nextjs` for SSR and API routes. Do not use `output: "export"` for this app because its OTP and SMS API routes require a server runtime. Configure the Customer site’s environment variables from the Backend environment section above.