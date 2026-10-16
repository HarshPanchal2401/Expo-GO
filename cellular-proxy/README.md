# Cellular Test proxy (holds the OpenCelliD API key)

The key must not be in the app. The app calls this small proxy; the proxy adds the key.
No Android Studio and no command line are needed: use the Cloudflare dashboard.

## Deploy (about 10 minutes, free)
1. Get an OpenCelliD API key: https://opencellid.org (sign up, then "API access token").
   The free allowance is **1,000 lookups per day**.
2. https://dash.cloudflare.com > **Workers & Pages** > **Create** > **Create Worker** > name it
   `cellular-test` > **Deploy**.
3. **Edit code**, replace everything with the content of `worker.mjs`, **Deploy**.
4. Worker > **Settings** > **Variables and Secrets** > add (type **Secret**):
   - `OPENCELLID_KEY` = your OpenCelliD key
   - `PROXY_TOKEN` = any long random text (optional but recommended)
5. Your proxy address is `https://cellular-test.<your-subdomain>.workers.dev`.
6. In the app: **Cell** tab > **Proxy** > enter that address (and the token) > Save.

## Check it
`https://<proxy>/cell?radio=LTE&mcc=404&mnc=10&lac=1&cellid=1` (send the `X-Proxy-Token` header if you set a token)
returns `{"ok":true,"found":false}` or a tower, never your key.

## What it does
- Accepts only `GET /cell` with `radio` (GSM, UMTS, LTE, NR), `mcc`, `mnc`, `lac`, `cellid`; checks each range.
- 6 s timeout to OpenCelliD, at most 20 requests a minute per client, 24 h cache (found) / 1 h (not found).
- Never logs or returns the key. Does not call anything except opencellid.org.
- Attribution: OpenCelliD data is CC BY-SA 4.0; credit OpenCelliD if you share results.
