# Island Murphy Beds Draft Checkout — Vercel Project

This is a complete, zero-dependency Vercel project. The endpoint is:

`/api/create-draft-order`

## Deploy

1. Extract this ZIP.
2. Upload the files inside the folder to the repository root, or create a new Vercel project from the folder.
3. In Vercel, open **Settings → Environment Variables**.
4. Copy the variables from `.env.example` and add the real values.
5. Apply variables to **Production** and redeploy.
6. Open `https://YOUR-PROJECT.vercel.app/api/create-draft-order`.
7. When the status returns `"ok": true`, test checkout from the Shopify builder.

## Required Shopify configuration

- `SHOPIFY_STORE_DOMAIN` must be the permanent `.myshopify.com` domain.
- The access token or client credentials must belong to the same Shopify store.
- The app/token requires the `write_draft_orders` scope.
- The builder variant should belong to the same store.

## Authentication

Recommended:

- `SHOPIFY_ADMIN_ACCESS_TOKEN`

Alternative:

- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

When both are configured, the static Admin API token is used first.

## Builder URL


Deployment trigger: Murphy production checkout update

The Shopify JavaScript must call the deployed production endpoint:

```js
const ENDPOINT = "https://YOUR-PROJECT.vercel.app/api/create-draft-order";
```

## Supported request fields

- `variantId`, `variantID`, or `variant_id`
- `quantity`
- `basePriceCents`
- `customizationPriceCents`
- `finalTotalCents`
- legacy `price` in dollars
- `properties`
- `currencyCode`

The endpoint returns `invoice_url` after draft creation.
