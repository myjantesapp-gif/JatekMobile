---
name: Jatek maps + storage architecture
description: How Google Maps, Leaflet fallback, and media storage work in the Jatek app — key decisions and known gotchas.
---

# Maps (Google + Leaflet fallback)

All map components (GoogleMapPicker, DriverMap, LocationMapPicker) use **WebView** with inline HTML, NOT react-native-maps. This avoids a custom dev client requirement.

**Key env var**: `EXPO_PUBLIC_GOOGLE_API_KEY` (also checked: `EXPO_PUBLIC_GOOGLE_MAPS_KEY`, `EXPO_PUBLIC_GOOGLE_PLACES_KEY` as fallbacks).

**Why**: `EXPO_PUBLIC_GOOGLE_API_KEY` was added as the canonical key. All 5 files that used the old name were updated.

When the key is present → Google Maps JS API. When absent → Leaflet (OpenStreetMap, free, no key). The fallback is automatic via `GOOGLE_KEY ? buildGoogleHtml() : buildLeafletHtml()`.

**EAS build gotcha**: The key must be added to EAS Secrets (expo.dev dashboard) in addition to Replit secrets. `eas.json` references it as `"$EXPO_PUBLIC_GOOGLE_API_KEY"`. Without EAS Secrets, APK builds won't embed the key.

**Native Android config**: `app.config.js` `android.config.googleMaps.apiKey` is also set for native map embedding (future react-native-maps support).

**DriverMap.tsx WebView fix**: Added `mixedContentMode="always"`, `domStorageEnabled`, `allowsInlineMediaPlayback`, `setSupportMultipleWindows={false}`. Without `mixedContentMode="always"`, Leaflet CSS/JS loaded from unpkg.com CDN would silently fail on Android.

**Leaflet loading**: DriverMap was using synchronous `<script src>` without onload/onerror. Fixed to use `onload="bootLeaflet()"` pattern matching the other components.

# Media Storage (dual: local + bucket)

**Existing flow (presigned URL)**: Client requests a signed PUT URL from `/storage/uploads/request-url` → uploads directly to Replit GCS bucket. Server never sees the file bytes.

**New flow (server-side dual)**: `POST /storage/uploads/server` with `multipart/form-data`. Multer receives the file in memory, then:
1. Saves to `./uploads/<uuid>.<ext>` on local disk
2. Uploads to Replit bucket via `objectStorageService.uploadBuffer()` in parallel
Returns `localPath`, `bucketPath`, and `objectPath` (prefers bucket).

**Why dual**: User requested local folder + bucket redundancy. If bucket fails, local is still available.

**Gotcha**: Local `./uploads/` may not persist across Replit container restarts. Serve local files via a static route in the API server for clients to access them.

# Twilio SMS

Works out of the box. `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER=+15072600620` are configured. Test script at `artifacts/api-server/scripts/test-twilio-sms.mjs`.
