# Internot AI (v0.3)

Offline AI, offline maps and offline phone-to-phone chat in one app that runs entirely on the device.
No server, no account, no data after the first visit.

Cost to build, host and share: **R0 / M0**.

## What works in this version

**The Brain (offline AI)**
- Chat with a local AI model (llama.cpp compiled to WebAssembly, bundled in `lib/`).
- Import a model file (`.gguf`) from phone storage, a memory card or a friend, or download one once over Wi-Fi.
- Documents: paste or add text files, then ask questions answered from them.
- Safeguards: memory check before importing a model, cool-down pauses during long answers,
  model unloaded when the app is left in the background, model files checked before they are accepted.

**Maps (offline navigation)**
- Add a map by importing an OpenStreetMap country file (`.osm.pbf`). The phone converts it once and keeps it.
- Pan and zoom the whole country, and search towns, villages, clinics, schools and fuel stations.
- Driving routes worked out on the phone, with a step list, distance and time.
- Live position from the GPS chip, spoken turn instructions, and automatic rerouting.

**Inter-Chat (offline messaging)**
- Link phones by scanning QR codes. Phones must share a Wi-Fi network or one phone's hotspot. No internet is needed.
- Messages are encrypted for the recipient (ECDH P-256 + AES-256-GCM). Phones in between pass them on but cannot read them.
- Reach people you are not linked to directly, through linked phones (multi-hop).
- Send photos and files up to 3 MB. Messages to someone out of reach wait and go when a path appears.

Everything works with the internet switched off after the first visit, and the app installs to the home screen.

## Limits you should know about

- **Chat links do not survive closing the app.** Phones must scan each other again each time, and the app must stay
  open on screen to send, receive or pass messages on. Bluetooth is not used. Removing these limits needs a native Android app.
- **Maps:** routes ignore turn restrictions, traffic and road closures, and travel times are estimates from road type.
  The map is always north-up. A first GPS fix with no data can take a minute or more outdoors.
- **Nothing saved on the phone is encrypted yet** (chats, documents, your chat identity). Fingerprint unlock also needs the native app.
- **Not built:** the offline ad engine, PDF and Word documents.

## Put it online for free (GitHub Pages)

1. Create a free account at github.com.
2. New repository → name it `internot` → Public → Create.
3. "uploading an existing file" → drag in **everything inside this folder** (including `lib/`) → Commit.
4. Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder `/ (root)` → Save.
5. After a minute or two the app is live at `https://YOUR-USERNAME.github.io/internot/`.

## If GitHub Pages shows 404

The address is `https://YOUR-USERNAME.github.io/REPO-NAME/` — the repo name is part of it.
`https://YOUR-USERNAME.github.io/` on its own only works for a repo named exactly `YOUR-USERNAME.github.io`.

Then check, in order:

1. **Open the repo's front page. You should see `index.html` in the file list.** If instead you see a single
   folder (such as `internot-ai-v0.4`), the files went in one level too deep. Open that folder, and the site is at
   `https://YOUR-USERNAME.github.io/REPO-NAME/internot-ai-v0.4/`. To fix it properly, delete the files and upload
   again — unzip first, open the folder, select everything **inside** it, and drag that in.
2. **Settings → Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. **The repo must be Public** on a free GitHub account. Pages from a private repo needs a paid plan.
4. **Wait two minutes** after committing. The Actions tab shows a green tick when the site is built.

## Install on a phone

1. Open the link in Chrome on Android. Wait for the page to load fully (about 11 MB, once).
2. Chrome menu → "Add to Home screen" / "Install app".
3. Setup tab → import a `.gguf` model, or download one over Wi-Fi.
4. Maps tab → add the map (see below).
5. Chat tab → choose a name → "Link a phone".
6. Switch on aeroplane mode and try it.

Choosing a model: any chat model in GGUF format under 2 GB. For phones with 3–4 GB of memory use a
0.5B–1B model at "Q4" (about 400–800 MB). Larger models answer better but are slower and need more memory.

## Add the Lesotho map

1. On Wi-Fi, go to https://download.geofabrik.de/africa/lesotho.html and download the `.osm.pbf` file.
2. In the app, open Maps → Add map file → choose that file. Wait for it to finish.

Any other country or region from the same site works the same way, up to 400 MB.
To make the map on a computer instead: `node tools-build-map.mjs lesotho-latest.osm.pbf lesotho.imap "Lesotho"`,
then import the `.imap` file on the phone.

Map data © OpenStreetMap contributors (Open Database Licence).

## Link two phones for chat

1. Put both phones on the same Wi-Fi, or switch on one phone's hotspot and join it from the other. Mobile data can be off.
2. Phone 1: Chat → Link a phone → Show my code.
3. Phone 2: Chat → Link a phone → Scan a code → point at phone 1. Phone 2 now shows a reply code.
4. Phone 1: Scan a code → point at phone 2. Both phones say "Linked".

A third phone that links to either one can message both.

## Changing the app

Edit the files, upload them again, and change the `VERSION` line at the top of `sw.js`
(e.g. `internot-v0.3.1`). Phones pick up the new version the next time they open the app online.

## Files

- `index.html`, `style.css`, `app.js` — the app shell and The Brain
- `maps.js`, `osmpbf.js`, `map-worker.js`, `tools-build-map.mjs` — maps
- `mesh.js` — Inter-Chat
- `sw.js`, `manifest.webmanifest`, `icon*` — offline support and home-screen install
- `lib/` — wllama 3.13.0 (MIT), qrcode-generator (MIT), jsQR (Apache-2.0)

## What has and has not been tested

Tested in desktop Chrome at phone screen size:
- The Brain, with a tiny test model: import, chat, documents, cool-down, unloading, offline use.
- Maps, with a synthetic town and a synthetic country-sized map (1.2 million road points): import, drawing,
  search, routing, one-way streets, spoken instructions, rerouting, reopening.
- Inter-Chat, with three simulated phones: QR pairing through a simulated camera, direct and relayed messages,
  delivery receipts, a 400 KB file through a relay, queued messages, reopening.

Not yet tested: any real phone, a real AI model, the real Lesotho map file, real GPS, real phone cameras,
and two real phones on a hotspot.
