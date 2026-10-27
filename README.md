# healthgear

FOSS connections to health devices, in the browser.

healthgear is a progressive web app that reads Bluetooth health devices directly in the browser, keeps every
reading on your device (IndexedDB), and sends copies where you choose: Google Health, a Google Sheet, Apple Health
(through a Shortcut), or plain CSV/JSON files. It's a static site, hosted on GitHub Pages. There's no server and no account.

**Live:** https://fingerskier.github.io/healthgear/ · there's a demo mode for browsers without Bluetooth.

> Not a medical device. healthgear shows what your hardware reports and nothing more.

## What actually works (and what can't)

| | Status | How |
|---|---|---|
| **Standard Bluetooth health devices** | ✅ direct | Web Bluetooth + the Bluetooth SIG profiles: blood pressure (0x1810), weight scale (0x181D), body composition (0x181B), heart rate (0x180D), thermometer (0x1809), pulse oximeter (0x1822), glucose (0x1808). Sets the device clock (Current Time or Date Time), pulls stored glucose records, and auto-reconnects when a cuff or scale wakes to send. |
| **Withings scales and cuffs** | ⚠️ via Withings cloud | Withings hardware speaks a proprietary, challenge-authenticated protocol. The device secret it needs lives only in Withings' cloud, so no browser can talk to it. You keep using the Withings app to measure, and healthgear imports from the Withings Public API, or from the Withings data-export CSVs. Withings accounts created after **12 Oct 2026** need a Withings+ membership before Withings shares data with apps like this. |
| **"Control" devices** (start a measurement remotely) | ❌ | Nothing in the standard profiles allows it, and Withings exposes no such API. What the profiles do allow: setting the clock and pulling stored records. healthgear does both. |
| **Google Health** | ✅ weight, body fat, height | Google Health API v4, called from the browser with your own OAuth client ID. **It has no blood-pressure type.** The Google account needs a Google Health (Fitbit) app profile. |
| **Google Fit** | ❌ | Closed to new apps since May 2024, shuts down end of 2026. |
| **Google Sheets** | ✅ everything | Appends every reading (blood pressure included) to a sheet the app creates in your Drive (`drive.file` scope only). |
| **Apple Health** | ⚠️ via Shortcuts | There's no web API for HealthKit. healthgear opens a Shortcut you build once, which runs *Log Health Sample* for each reading. |
| **iPhone Bluetooth** | ⚠️ | No iOS browser supports Web Bluetooth, and Home Screen web apps never do. Use the [Bluefy](https://apps.apple.com/app/id1492822055) browser, or Safari with the beacio extension (iOS 26.2+). |

Browsers with Web Bluetooth: Chrome and Edge on Windows, macOS, ChromeOS and Android, and Samsung Internet. On
Linux, enable `chrome://flags/#enable-web-bluetooth`. Firefox and Safari don't support it, and Brave turns it off by
default.

On **Windows and Linux**, Chrome can't do "Just Works" pairing by itself, and most cuffs and scales use it. Pair
the device once in the OS Bluetooth settings, then connect from healthgear.

### Devices known to use the standard profiles

Most devices that advertise "Bluetooth" or "works with Apple Health via the vendor app" **don't** use them, so check first.

- **Known good:** A&D Medical UA-651BLE cuff and UC-352BLE scale. Beurer BM/BC 54, 57, 77, 85 and BM 81 cuffs
  (BM 81 asks for a PIN on first pairing). Medisana connect cuffs. Sanitas SBC/SBM and Silvercrest SBM 68/69 cuffs.
  Samsung Smart Scale. Accu-Chek Instant and Contour Next One glucose meters. Polar, Garmin, Wahoo and most other
  heart-rate straps.
- **Partly:** Omron cuffs expose the standard profile, but often only the latest reading. Their full memory sits
  behind Omron's proprietary protocol. Beurer BF and Sanitas SBF scales may want a registered user (Bluetooth User
  Data Service) before they send body composition. That registration isn't implemented yet, so expect weight only.
- **Not supported:** Withings (see above), Xiaomi, Renpho/QN, Eufy, Etekcity, Yunmai and most budget scales and
  cuffs, which use proprietary protocols, sometimes behind standard UUIDs. Scales that only broadcast (Xiaomi S400,
  Eufy C20) can't be read by stock Chrome at all.

Device support reports are welcome in the issues.

## Using it

1. **Devices** → *Find health devices*. Wake the device first: press its button or step on the scale. Readings save
   automatically. Leave *Auto-reconnect* on and the tab visible, and the next reading is picked up without the chooser.
2. **Readings** shows your latest values, trends and history. *Add reading* is for manual entry.
3. **Sync** holds Withings import, Google, Apple Health, and file export/import.
4. **Settings** has units, persistent storage, and data deletion.

Install it (browser menu → *Install* / *Add to Home Screen*) for offline use. Nothing leaves the device unless you
press a sync button. Demo readings never leave at all.

### Withings setup

1. At [developer.withings.com](https://developer.withings.com/dashboard/), create an application: *Withings public cloud* →
   *Public API integration*, environment *Development*.
2. Set the callback URL to `https://fingerskier.github.io/healthgear/`. It must match exactly, trailing slash included.
3. Paste the Client ID and Secret into **Sync → Withings**, then press *Connect*. The secret stays in your browser
   and only goes to Withings.

Withings requires the secret for every token exchange and doesn't support PKCE. A deployment can instead offer
one-click **Connect Withings** through a small token broker, [`worker/withings-broker.js`](worker/withings-broker.js)
(a Cloudflare Worker; instructions in the file). The broker holds one Withings app's secret and only performs token
exchanges; health data never passes through it. To enable it, set the repository variables `WITHINGS_BROKER_URL` and
`WITHINGS_CLIENT_ID`. The build then pins the broker's exact origin in the CSP and shows the one-click button.
Without them, only the bring-your-own route is offered.

No API access? In the Withings app, use *Download my data* and import `weight.csv` / `bp.csv` under **Sync → Files**.

### Google setup

1. In Google Cloud Console, create a project and enable the **Google Health API** and the **Google Sheets API**.
2. Google Auth Platform: set Audience to *External* and status to *Testing*, and add yourself as a test user. Under Data
   access, add `.../auth/googlehealth.health_metrics_and_measurements.writeonly` and `.../auth/drive.file`.
3. Create an OAuth client of type *Web application*, with the authorized JavaScript origin `https://fingerskier.github.io`.
4. Paste the client ID into **Sync → Google**.

Access tokens last an hour and are never stored, so every sync starts with a button press. Google labels the app
unverified; it is your own project, and Google Health scopes are restricted, which is why each user brings their own client.
The Google account must already have a Google Health (formerly Fitbit) app profile, or Google refuses the writes.

### Apple Health setup

**Sync → Apple Health** has step-by-step instructions for building the `healthgear import` shortcut. The payload is
grouped by Health type, because *Log Health Sample* can't take its type from a variable. That way the shortcut is a
handful of identical *Repeat* blocks. After the shortcut runs, confirm in healthgear so it doesn't send the batch
again. Health has no duplicate detection.

## Privacy and security notes

- Readings, settings, and any Withings secret or refresh token live in this browser's IndexedDB. Nothing is sent
  anywhere until you press a sync button. The production build's Content-Security-Policy limits network traffic to
  the services listed above, and the app refuses to run inside a frame.
- **Shared origin:** every GitHub Pages project under one account is served from the same origin
  (`https://<user>.github.io`), so those sites can read each other's storage. If you host healthgear next to other
  Pages projects, put it on its own domain: set a custom domain and build with `BASE_PATH=/`. Then update the Withings
  callback and the Google JavaScript origin to match.
- Deleted readings stay deleted: a device re-sending its memory, or a re-import, won't bring them back.

## Development

```sh
npm install
npm run dev        # http://localhost:5173/healthgear/
npm test           # parsers, assembler, storage, adapters
npm run lint
npm run build      # dist/, with service worker and CSP
```

Web Bluetooth needs a secure context; `localhost` counts. GitHub Pages deploys from `main` through
`.github/workflows/pages.yml`. In the repo settings, set *Pages → Source* to **GitHub Actions**. For a fork or a
custom domain, build with `BASE_PATH=/your-path/`.

### Layout

```
src/ble/         IEEE-11073 numerics, GATT parsers, profile registry, assembler, Web Bluetooth session, simulators
src/sources/     Withings cloud client
src/sinks/       Google Health + Sheets, Apple Shortcuts bridge
src/state/       app state (device sessions, Withings/Google orchestration, settings, toasts)
src/ui/          React views
src/db.ts        Dexie schema, dedupe, sync marks
src/model.ts     canonical units and reading model
worker/          optional Withings token broker (Cloudflare Worker)
```

Readings are stored in canonical units: kg, m, %, mmHg, bpm, °C, mmol/L. Conversion happens only at the edges.
Each reading carries a dedupe key, so devices that re-send their memory on every connect, and repeated Withings
imports, never create duplicates.

### Adding a device

A device that uses a standard profile should just work. For a proprietary one, add a profile to `src/ble/profiles.ts`
with its service UUID and a parser that returns a `NewReading`, plus a byte-level test in `src/ble/parsers.test.ts`.

## License

Apache-2.0
