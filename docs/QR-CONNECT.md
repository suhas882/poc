# Connect via QR

On **Connected Sources**, Gmail, Google Drive, Outlook mail, OneDrive, SharePoint and Microsoft Teams each have a **Connect via QR** button next to their normal **Connect** button. You choose the same options as usual (which mail, who can search it, the SharePoint site), scan the code with your phone, and sign in to Google or Microsoft on the phone. The computer updates by itself when the connection is complete.

This connects a data source to your website account. It does **not** sign anyone in to the website, and the phone never gets a website session.

## Which official mechanism each app uses

| App | QR mechanism | Why |
|---|---|---|
| Gmail, Google Drive | QR-assisted OAuth 2.0 authorization code flow with PKCE | Google's device authorization flow does not allow the `gmail.readonly` or `drive.readonly` scopes, so it cannot be used for these. |
| Outlook mail, OneDrive, SharePoint, Teams | QR-assisted OAuth 2.0 authorization code flow with PKCE (Microsoft identity platform / Entra ID) | Microsoft supports a device-code flow, but it is a common phishing route that Microsoft advises organizations to block with Conditional Access, so many tenants refuse it. The authorization code flow works everywhere the normal Connect button works. |
| Android texts (companion app) | Its own one-time pairing code and QR code ("Pair via QR") | The companion app pairs with this site directly; see [ANDROID.md](ANDROID.md). |
| Android texts (Phone Link) | None | Phone Link's QR pairing is between the phone and Windows, inside Microsoft's apps. This site cannot start or join it, and recent Phone Link versions encrypt the texts on the PC. Use the companion app. |
| PostgreSQL, MySQL, SQLite, uploads, public documents, message imports | None (unchanged) | These are not account sign-ins, so they keep their existing connection methods. |

No QR code ever holds a token, authorization code, password or client secret.

## How it works

1. **Start (computer).** `POST /api/connections/qr/start` creates an attempt bound to the signed-in user **and** to that browser session. It gets a 256-bit random reference (only its SHA-256 hash is stored), a two-digit match number, and **3 minutes** to be opened.
2. **QR code.** It holds only `https://<your site>/qr/<reference>`.
3. **Phone page.** `GET /qr/<reference>` shows which website account and organization the connection is for (the email is masked) and the match number. It asks the person to continue only if their computer shows the same number. Opening the link changes nothing, so link previews and scanners cannot use it up.
4. **Continue (phone).** A same-origin `POST /qr/<reference>/continue` claims the attempt **exactly once**, then redirects to Google's or Microsoft's own consent page. It uses the same registered redirect URI, PKCE challenge, one-time `state` and read-only scopes as the normal Connect button. The attempt records the hash of that `state`.
5. **Callback.** The existing `/oauth/google/callback` and `/oauth/microsoft/callback` routes recognize the state of a QR attempt. The source is created only if all of these hold:
   - the state belongs to this attempt and this provider;
   - the attempt is still being authorized (it was not cancelled or expired);
   - the code exchange succeeds with the PKCE verifier;
   - the needed scope was granted.

   It is then created for the attempt's user, exactly as a normal connection would be. Scanning the code alone never counts as success.
6. **Live status (computer).** The page polls `GET /api/connections/qr/status/:attemptId` every 2 seconds and shows Waiting → Signing in → Connected, or Failed, Expired or Cancelled. Then it refreshes Connected Sources. Only the browser session that started an attempt can see or cancel it.
7. **After connecting**, the source is the same as one connected normally: it shows the account and the granted scopes, keeps Sync now, Sync history, Check access, Activity, Sharing and Disconnect, and follows the existing approval and first-sync rules.

### Safeguards

| Threat | Protection |
|---|---|
| Guessing or brute-forcing a code | 256-bit references, only hashes stored, rate limits on the phone pages. |
| Reusing a code, or replaying a callback | The Continue step works once. The OAuth state is single-use and deleted after the callback. A finished or cancelled attempt cannot be finished again. |
| Expired codes | 3 minutes to open a code, and 10 minutes to finish signing in (the OAuth state's lifetime). |
| Someone forwarding you their QR code to link your account to theirs | The phone shows whose website account it is for and the match number, with a warning to cancel if the number is not on your own screen. |
| Session hijacking or watching someone else's attempt | Attempts are bound to one user and one browser session. Status and cancel are refused for anyone else. |
| Cross-site requests | Same-origin check on the phone's form posts. The page's Content-Security-Policy lets the form continue only to the configured sign-in origin. Normal API routes keep their CSRF tokens. |
| Too many attempts | At most 5 open attempts per person, and 20 starts per 10 minutes. |
| Audit | Started, opened, cancelled, connected (`via: qr`) and failed attempts are written to the audit log, without any tokens. |

Tokens are stored encrypted on the server exactly as for a normal connection (`CREDENTIAL_ENCRYPTION_KEY`).

## Microsoft Teams

Teams is a new source type. It reads **your own chats** (one-to-one, group and meeting chats) with the delegated **Chat.Read** permission; channel posts are not included. Each message becomes a searchable record. Later syncs read only the messages changed since the last sync in each chat, and messages deleted in Teams are removed here. It needs a **Microsoft 365 work or school account**, because Microsoft does not expose personal accounts' Teams chats to other apps. Some organizations require an administrator to approve Chat.Read first. Channel posts would need ChannelMessage.Read.All, which always requires administrator consent, so they are not included.

## Setup (deployment)

No new redirect URIs and no new secrets are needed: QR connections use the existing callbacks.

1. **Use HTTPS:** set `PUBLIC_URL` to the site's public https address (Render, Azure). A phone cannot reach `localhost`, and the page warns about that.
2. **Microsoft Entra ID** (App registrations → your app → API permissions): add the delegated Microsoft Graph permission **Chat.Read** for Teams. User.Read, Mail.Read, Files.Read, Sites.Read.All and offline_access are already there for the other Microsoft sources. For work tenants that restrict user consent, an administrator grants consent for Chat.Read and Sites.Read.All.
3. **Google:** nothing changes. Gmail and Drive keep their existing OAuth client, scopes and redirect URI.
4. Deploy. The new database migration (`013_qr_connect_teams.sql`) runs automatically on start.

## Testing

**Covered by automated tests** (`npm test`, file `tests/qr-connect.test.mjs`), against stand-in Google and Microsoft servers that check PKCE:

- the full QR flow for Google and for Microsoft Teams;
- codes that work once, link previews that do not use them up, and expiry;
- cancelling while the phone is on the provider's page;
- declined consent, a forged authorization code, and a state sent to the wrong provider;
- other browser sessions and signed-out callers refused;
- the open-attempt limit;
- no plaintext tokens in the database, and no website session on the phone;
- audit entries;
- the Teams sync, including incremental changes and deletions, and Check access.

**Checked in a browser locally:** the buttons on each card, the QR popup, the phone page at phone size, and the live update on the computer for Gmail and Teams (with stand-in providers). Also the Cancel button, and the browser rule that the sign-in redirect must be allowed by the page's security policy (a bug found and fixed this way).

**Needs live credentials, not tested here:**
- real Google and Microsoft consent pages on a real phone;
- Teams against a real Microsoft 365 tenant (including Graph's `$filter` on chat messages);
- SharePoint and OneDrive through QR on a real account;
- organizational consent prompts.

Test these on the deployed https site with a real phone.
