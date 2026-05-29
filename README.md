# Retail Monitor

Local/live-hostable web app for visitor movement records.

## Features

- Login with admin and normal users
- Admin user management and audit logs
- Operating day from 07:00 to next day 06:00
- Visitors Jetty, Airport Visitors, All Visitors, and Private Boats totals
- Wristband category color setup
- History view and CSV export
- Local JSON database with optional persistent hosting data directory

## Run Locally

```sh
npm start
```

Open:

```text
http://localhost:4173
```

## Environment

Copy `.env.example` values into your hosting provider environment settings.

- `PORT`: hosting port, usually provided by the platform
- `HOST`: use `0.0.0.0` for live hosting
- `DATA_DIR`: persistent data folder
- `ADMIN_PASSWORD`: initial admin password for a new database

Default login for a new local database:

- Username: `admin`
- Password: value of `ADMIN_PASSWORD`, or `Cross@7007` if unset

For live hosting, set `ADMIN_PASSWORD` before first run and use a persistent disk for `DATA_DIR`.

## Deploy

This repo includes:

- `Procfile` for Heroku-style hosts
- `render.yaml` for Render
- `package.json` with `npm start`

Do not commit the `data/` folder. It contains users, audit logs, records, and backups.
