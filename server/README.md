# Internot AI server

A small server for the Internot AI app. It runs free on [Render](https://render.com) with a free [Neon](https://neon.tech) Postgres database.

It does three things:

- **Counts devices.** When the app is online it can send a random id it made for itself, plus the app version, platform (android, web), country code and language. No IP address, name, phone number, location or anything typed in the app is stored.
- **Serves adverts.** You add adverts; the app fetches them when online and keeps them for offline use. The app can report how many times each advert was shown, so you can give sponsors a view count.
- **Announces updates.** You set the newest version and a download link; the app can show "new version available".

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
| `GET /v1/content` | | `{"ads":[...],"update":{"version","url","notes"}}` |
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

Example, from a computer:

```
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-service>.onrender.com/v1/stats
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"title":"Pioneer Mall","body":"Open every day 8 to 6","link_url":"https://example.com"}' \
  https://<your-service>.onrender.com/v1/ads
```

## Before the app sends anything

The app does not talk to this server yet. Before it does, it should ask the user once ("Share an anonymous count? Yes / No") and work fully offline either way. Google Play's Data safety form and Apple's privacy label must then list the anonymous id and app version.
