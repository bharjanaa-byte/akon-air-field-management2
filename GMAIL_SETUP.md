# Automatic GoLime Master Dispatch import

The app can securely check one connected Gmail mailbox for the daily GoLime Master Dispatch PDF, ignore Work Order Notes, and import only work orders that are not already in the shared Akon Air workspace.

It checks at **9:40 AM Toronto time on weekdays**. The two UTC schedule checks safely cover both daylight-saving offsets; the same email is never imported twice.

## One-time setup

### 1. Deploy from a Git repository

The email connection and automatic schedule are server-side features. They require a normal Netlify deployment from a Git repository, not a drag-and-drop ZIP upload.

1. Create a private GitHub repository and upload this complete project folder to it.
2. In Netlify, open the existing Akon Air site, choose **Add new site configuration** or **Link to a Git provider**, and connect that repository.
3. Confirm Netlify detects the settings in `netlify.toml`, then deploy.

### 2. Create the secure database table

In Supabase, open **SQL Editor**, create a new query, paste the complete contents of `gmail-integration.sql`, and run it once.

### 3. Create Google credentials

1. In [Google Cloud Console](https://console.cloud.google.com/), create or choose a Google project.
2. Open **APIs & Services → Library**, find **Gmail API**, and enable it.
3. Open **APIs & Services → OAuth consent screen**. Choose External for a personal Gmail account, complete the basic app details, and add the Gmail account you will connect as a test user while the app is in testing.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
5. Choose **Web application** and add this exact authorized redirect URI:

   `https://fabulous-rugelach-e8bc76.netlify.app/.netlify/functions/gmail-oauth-callback`

   If your Netlify address changes, replace only the domain with the new published address.
6. Save the client ID and client secret. Keep the secret private.

### 4. Add secure Netlify variables

In Netlify, open **Site configuration → Environment variables** and add these values for the production site:

- `GMAIL_CLIENT_ID` — Google OAuth client ID
- `GMAIL_CLIENT_SECRET` — Google OAuth client secret
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase **service_role** key (never place this in app files)
- `OAUTH_STATE_SECRET` — a long, new random value used only by this server
- `DISPATCH_GMAIL_QUERY` — the exact Gmail search that identifies the dispatch email. Start with:

  `has:attachment filename:pdf subject:"Master Dispatch Schedule"`

  Add `from:sender@example.com` once you know the dispatch sender. This makes the import safer by avoiding other PDFs in the mailbox.

### 5. Connect and test

1. Deploy the Git-connected Netlify site again so the variables and functions are live.
2. Sign in to the Akon Air app.
3. On Home, under **Master Dispatch email**, tap **Connect Gmail** and approve read-only Gmail access.
4. Return to the app and tap **Check Gmail now**.
5. Confirm the imported jobs appear in Jobs. Future emails are picked up automatically on weekday mornings.

## Privacy and safety

The Google permission is read-only. The app does not send, delete, or modify email. It searches only the Gmail query you choose, downloads the matching PDF, and saves the Gmail refresh token only in the protected Supabase table, where the app browser cannot read it.
