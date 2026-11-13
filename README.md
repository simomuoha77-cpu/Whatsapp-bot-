# Optional Community Contact Sync — revised integration patch

This patch keeps the existing client authentication and registration flow unchanged: users register with their existing WhatsApp phone-number login and password. Community membership is NOT required at signup.

After logging in, a user can open **Automatic Community Contact Sync** on the client dashboard. To join, they enter the display name they want other members to see, confirm/edit the WhatsApp number, tick the opt-in checkbox, and save. Unticking it and saving withdraws them from the directory. Only opted-in members are returned by the contact-sync API.

The companion Android app must be generated in the Web App Builder with **contacts (automatic community phonebook sync)** enabled. When the user taps Save while joining, the dashboard calls the native Android bridge and Android immediately requests READ_CONTACTS and WRITE_CONTACTS if they have not already been granted. If permission was already granted, no prompt is shown. The bridge also checks permission before writing contacts. The WebView polls while active; this is not guaranteed continuous background sync when Android suspends the app.

The name and number are shared with all other opted-in community members. Users should only join if they agree to that sharing. Existing contacts are not duplicated by the APK bridge.

## Files
- `src/handlers/client.js`: optional dashboard opt-in; no community fields at registration.
- `src/db/communityContacts.js`: membership read/join/withdraw operations.
- `src/db/migrate.js`: community collection indexes.
- `src/utils/androidTemplate.js`: Android phonebook bridge.
- `src/handlers/webAppBuilder.js`: existing contacts permission option.
- `test/communityContactSync.test.js`: integration checks.

## Verification
Run `node --test test/*.test.js` from the project root. The included tests verify the Android contact bridge and that registration does not require community membership.
