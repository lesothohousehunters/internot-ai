# Internot AI server

A small server for the Internot AI app. It runs free on [Render](https://render.com) with a free [Neon](https://neon.tech) Postgres database.

It does five things:

- **Counts devices.** When the app is online it can send a random id it made for itself, plus the app version, platform (android, web), country code and language. No IP address, name, phone number, location or anything typed in the app is stored.
- **Serves adverts.** You add adverts; the app fetches them when online and keeps them for offline use. The app can report how many times each advert was shown, so you can give sponsors a view count.
- **Announces updates.** You set the newest version and a download link; the app can show "new version available".
- **Sells packs with unlock codes.** You list a paid map or AI model with a price. A buyer pays you (M-Pesa, EcoCash, cash) and gets a code; the app sends the code and receives the download address. Each code works on one phone (or up to 10 if you choose).
- **Admin page.** Open `https://<your-service>.onrender.com/admin`, paste the `ADMIN_TOKEN`, and see the numbers, add adverts, print a one-page sponsor report, manage paid packs and make codes, and set the update notice.

## Set up (about 10 minutes, free)

1. **Neon:** sign up at neon.tech, create a project, and copy the connection string (it starts with `postgresql://` and ends with `?sslmode=require`).
2. **Render:** sign up at render.com with your GitHub account. Choose **New → Blueprint**, pick the `internot-ai` repository, and Render reads `render.yaml`.
3. When Render asks for `DATABASE_URL`, paste the Neon connection string. `ADMIN_TOKEN` is made for you; open the service's **Environment** tab to copy it. Keep it secret.
4. Render builds and starts the server. Open `https://<your-service>.onrender.com/health`; it should say `{"ok":true,"db":true}`. The tables are created on first start.

The free Render service sleeps after 15 minutes without visits, so the first request after a quiet spell takes up to a minute. The app should not wait for it.

## API

Public (the app):

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /v1/ping` | `{"id":"<random id, 16-64 letters/digits/dashes>","version":"1.0","platform":"android","country":"LS","lang":"en","views":{"3":5}}` | `{"ok":true}` |
| `GET /v1/content` | | `{"ads":[...],"update":{"version","url","notes"},"packs":[{"id","kind","name","price","size"}]}` |
| `POST /v1/redeem` | `{"code":"ABCD-EFGH-JKLM","pack":"<pack id>"}` | The pack with its `url`, `sha256` and `size`; 404 unknown code, 409 already used |
| `GET /health` | | `{"ok":true,"db":true}` |

Admin (header `Authorization: Bearer <ADMIN_TOKEN>`):

| Method and path | Body | What it does |
| --- | --- | --- |
| `GET /v1/stats` | | Devices in total, active in the last 1, 7 and 30 days, new this week, by platform, version and country, daily active devices for 30 days, advert views |
| `GET /v1/ads` | | All adverts |
| `POST /v1/ads` | `{"title","body","image_url","link_url","starts_at","ends_at","active"}` | Add an advert |
| `PATCH /v1/ads/<id>` | any of the fields above | Change an advert |
| `DELETE /v1/ads/<id>` | | Remove an advert |
| `PUT /v1/update` | `{"version","url","notes"}` | Set the newest version |
| `GET /v1/packs` | | All paid packs |
| `PUT /v1/packs/<id>` | `{"kind":"map" or "model","name","price","url","sha256","size","active"}` | Add or change a paid pack |
| `DELETE /v1/packs/<id>` | | Remove a pack and its codes |
| `POST /v1/codes` | `{"pack","count":1-500,"uses":1-10,"note"}` | Make unlock codes |
| `GET /v1/codes?pack=<id>` | | Codes, how often each was used |
| `GET /admin` | | The admin page |

Example, from a computer:

```
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-service>.onrender.com/v1/stats
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"title":"Pioneer Mall","body":"Open every day 8 to 6","link_url":"https://example.com"}' \
  https://<your-service>.onrender.com/v1/ads
```

## What the app sends

The app asks once, on first start: "Share an anonymous count? Yes / No". It works fully offline either way, and the choice can be changed under Setup → Settings.

- **Yes:** once a day when online, `POST /v1/ping` with a random id the app made, the app version, `android` or `web`, the region from the phone's language setting, and advert view counts.
- **Always, when online:** `GET /v1/content` every few hours for adverts, update notices and paid packs. No id is sent.
- **Only when someone unlocks a pack:** `POST /v1/redeem` with the code.

The app expects the server at `https://internot-server.onrender.com` (set in `internot-ai-v0.4/online.js`). If Render gives your service another address, or you move it to your own domain, change `SERVER` there.

Google Play's Data safety form and Apple's privacy label must list the anonymous id, app version and region.

## Paid packs: things to know

- The download address is only sent after a code is accepted, but anyone who has the address can share it. For real protection, keep paid files somewhere that is not public (for example a private Cloudflare R2 bucket with expiring links).
- On Google Play and the App Store, digital items unlocked inside an app must normally be sold through Google Play Billing or Apple in-app purchase. Codes sold outside are fine for the APK you hand out yourself and for the website; check the store rules before turning paid packs on in a store build.
