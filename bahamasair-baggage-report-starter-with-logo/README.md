# Bahamasair Baggage Irregularity Report — Starter Repo

Includes:
- `index.html` — production form (Origin before Destination, temp address + days, weight kg/lb, multi-segment flights, IATA help).
- `netlify/functions/submit.js` — robust function with normalization and optional diagnostic mode (`?debug=1`).
- `netlify.toml` redirect and `package.json` deps.
- `assets/` images (replace with real logo/IATA chart as needed).

## Deploy
1) Create a new GitHub repo and push.
2) Netlify → New site from Git.
3) Add env vars: `SENDGRID_API_KEY`, `FROM_ADDRESS`, `FROM_NAME`, `TO_PRIMARY`, (`TO_NAS`, etc.), optional `TO_DEFAULT_STATION`.
4) Trigger deploy with **Clear cache and deploy site**.

## Debug (no email)
Temporarily set form action to `/api/submit?debug=1` to see received keys and sample values.

## Local
Open `index.html` in a browser (submitting requires Netlify functions).
