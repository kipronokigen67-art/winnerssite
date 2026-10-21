# Winners.site

A trading workspace for Deriv with a native Winners bot dashboard, a Blockly strategy
builder, an interactive SmartCharts chart, and tutorials.

> **Note:** Unlike the other templates in this repo (Rise/Fall, Accumulators, Digits)
> which are **Next.js** apps, the bot is a **[Rsbuild](https://rsbuild.dev) + React
> Router** single-page app. The commands, build output, and environment variables
> below differ accordingly.

## Native bots

The dashboard includes the **Over 2 → Under 7 recovery bot** as an in-app native
workflow; it does not require XML downloads. It discovers open symbols and the
Over/Under contracts available for the selected symbol from Deriv before any purchase.
It uses finite signal and session deadlines, bounded tick history, explicit
demo/real account selection, stake and session limits, confirmed contract outcomes,
and a Stop control. A loss changes the next configured strategy only after Deriv
confirms that contract as lost. This is a risk-management workflow, not a claim of
profitability.

Other contract types remain available through the existing Blockly builder. They are
not presented as operational native bots until their own configuration and execution
flows are implemented.

## Prerequisites

- Node.js 22 or later

## Step 1: Register Your App ID

1. Navigate to [App Registration](https://developers.deriv.com/dashboard/) and register a new application.
2. Set the **Redirect URI** to the exact app origin (for example, `http://localhost:4003` locally or `https://winners.site` in production).
3. Enable the `trade` OAuth scope required by native trading.
4. Copy the **App ID** shown after registration. Users authorize through OAuth; do not put account tokens in build configuration.

## Step 2: Configure the build environment

Provide the public settings below through your local build environment or hosting
provider. The app ID, environment, app name, and referral URL are embedded in the
client bundle; never place account tokens, passwords, or private credentials in
`NEXT_PUBLIC_*` settings.

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_DERIV_APP_ID` | Deriv OAuth client ID issued for your registered app. Drives login/sign-up; the public market-data feed does not use this value. Without it, Log in / Sign up stay disabled. |
| `NEXT_PUBLIC_DERIV_ENV` | `production` for live Deriv endpoints; `preview` (or `staging`) for staging. Read by both the bot's URL resolver and `@deriv/core` for OAuth. |
| `NEXT_PUBLIC_DERIV_REFERRAL_LINK` | Affiliate referral link — appended as `affiliate_token` / `utm_campaign` on OAuth (optional). |
| `GD_CLIENT_ID` / `GD_APP_ID` / `GD_API_KEY` | Google Drive integration credentials for saving/loading strategies (optional). |

> These variables are injected at **build time** via Rsbuild's `source.define`
> (see `rsbuild.config.ts`), so re-build after changing them.

## Branding (`brand.config.json`)

The App Builder also writes branding into `brand.config.json`. Relevant `platform` keys:

| Key | Description |
|---|---|
| `platform.name` | In-app display name (header, tab title, favicon). Set in App Builder Customise. Overridden by `NEXT_PUBLIC_DERIV_APP_NAME` when that env var is set. |
| `platform.show_name` | `true` (default) shows the name next to the logo on desktop; `false` hides it |

Tab title and favicon use `NEXT_PUBLIC_DERIV_APP_NAME` when set, otherwise `platform.name` (with a generic fallback), and are not blanked when `show_name` is false. OAuth/consent registration name is separate and is not written into these fields by App Builder.

## Step 3: Local Development

```bash
npm install
npm run dev
```

The app is available at `http://localhost:4003`. (`npm install` and `npm run dev`
also regenerate brand CSS — see Branding below.)

## Step 4: Build for Production

```bash
npm run build
```

This produces a static build in the `dist/` directory (Rsbuild output — there is no
`.next`/`out`). Serve the contents of `dist/` from any web server or static host.
SmartCharts engine assets are copied into `dist/js/smartcharts/` during the build.

## Public market analysis

The **AI Analysis** link opens an independent `/analysis` page. It uses Deriv's
environment-selected public market-data WebSocket to discover currently available
volatility indices and digit contract types, and retrieve genuine tick history and
live ticks. It does not need the OAuth client ID or an account token, authorize an
account, place contracts, or start or change a bot. If the public feed disconnects,
an API request fails, or data becomes stale, the page reports that condition instead
of presenting old or simulated values as live.

The page reports digit frequencies and deterministic statistical checks against
uniform-digit reference rates. A signal is a descriptive historical watch condition,
not a prediction or a recommendation to trade; its evidence-strength score is not a
probability of profit. Signal history is kept in that browser's local storage and
never represents actual contract outcomes. No OpenAI-compatible service or paid AI
API is required or called by this feature.

## Google Drive integration (optional)

Saving/loading strategies to Google Drive stays disabled unless `GD_CLIENT_ID`,
`GD_APP_ID`, and `GD_API_KEY` are all set. **If it's not set up in your host
environment yet:**

1. **Get the credentials** — follow Google's [Picker set-up guide](https://developers.google.com/workspace/drive/picker/guides/web-picker#set-up-environment):
   enable the **Google Picker API** + **Drive API**, then create an **OAuth 2.0
   Client ID** (Web application) and an **API key**. Use the project number as `GD_APP_ID`.
2. **Authorize your domain** — add your deployed URL (e.g. `https://your-app.vercel.app`)
   to the OAuth client's **Authorized JavaScript origins** (exact origin; no wildcards).
3. **Set them in your host env — not in source** — add the three vars to your host
   (Vercel → Settings → Environment Variables; Heroku → Settings → Config Vars).
   Don't commit them to the repo.
4. **Rebuild** — they're baked in at build time (`source.define`), so trigger a new build/deploy.

> Deploying via Deriv App Builder? Open your app in **Edit** mode and enter these
> three values — App Builder injects them into your host environment for you
> (never into the app source).

## Branding & White-labeling

Branding (logo, primary color, fonts, app name) is driven by **`brand.config.json`**,
not Next.js config:

- **Colors / fonts / app name** — edit `brand.config.json`, then run
  `npm run generate:brand-css` to bake the values into the theme CSS variables. This
  runs automatically on `npm install`, `npm run dev`, and `npm run build`.
- **Logo** — drop a `public/logo.<png|jpg|jpeg|webp>` to set the header logo; it is also
  used as the favicon. Without it, a letter badge (the app name's first letter) is shown.
- **Theme** — a light/dark toggle lives in the header; the chart re-themes with it.

When assembled by the App Builder, these are configured for you (logo upload, color,
font, and app name are injected at deploy time).
