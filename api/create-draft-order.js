const FALLBACK_ALLOWED_ORIGINS = new Set([
  "https://islandmurphybeds.com",
  "https://www.islandmurphybeds.com",
  "https://island-murphy-bed.myshopify.com",
  "https://murphybedplace.com",
  "https://www.murphybedplace.com",
  "https://hi70xm-dw.myshopify.com",
]);

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function getAllowedOrigins() {
  const csv = String(process.env.ALLOWED_ORIGINS_CSV || "").trim();
  if (!csv) return FALLBACK_ALLOWED_ORIGINS;

  const values = csv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set(values.length ? values : Array.from(FALLBACK_ALLOWED_ORIGINS));
}

function applyCors(req, res) {
  const origin = req.headers?.origin || null;
  const allowedOrigins = getAllowedOrigins();

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
}

function sendJson(req, res, status, payload) {
  applyCors(req, res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sanitizeStoreDomain(domain) {
  return String(domain || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function toPositiveInt(value, fallback = 1) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  const integer = Math.floor(numberValue);
  return integer > 0 ? integer : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  const integer = Math.round(numberValue);
  return integer >= 0 ? integer : fallback;
}

function dollarsToCents(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return 0;
  return Math.round(numberValue * 100);
}

function stringifyPropertyValue(value) {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeVariantNumericId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const gidMatch = raw.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/i);
  if (gidMatch) return gidMatch[1];

  return /^\d+$/.test(raw) ? raw : "";
}

function formatVariantGid(value) {
  const numericId = normalizeVariantNumericId(value);
  return numericId ? `gid://shopify/ProductVariant/${numericId}` : "";
}

function getCustomAttributes(properties = {}) {
  return Object.entries(properties)
    .filter(([key]) => String(key).trim() !== "")
    .map(([key, value]) => ({
      key: String(key).slice(0, 255),
      value: stringifyPropertyValue(value).slice(0, 5000),
    }));
}

function hasClientCredentialsConfigured() {
  return Boolean(
    String(process.env.SHOPIFY_CLIENT_ID || "").trim() &&
      String(process.env.SHOPIFY_CLIENT_SECRET || "").trim()
  );
}

function clearCachedAccessToken() {
  cachedAccessToken = null;
  cachedAccessTokenExpiresAt = 0;
}

async function fetchClientCredentialsToken(storeDomain) {
  const clientId = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET");
  }

  const tokenUrl = `https://${storeDomain}/admin/oauth/access_token`;
  const form = new URLSearchParams();
  form.set("grant_type", "client_credentials");
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }

  if (!response.ok || !data?.access_token) {
    throw new Error(
      data?.error_description ||
        data?.error ||
        `Token exchange failed with status ${response.status}`
    );
  }

  const expiresIn = Number(data.expires_in || 86399);
  cachedAccessToken = String(data.access_token);
  cachedAccessTokenExpiresAt = Date.now() + expiresIn * 1000;

  return cachedAccessToken;
}

async function getShopifyAccessToken(storeDomain) {
  const staticToken = String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();

  // Prefer the static token when supplied, so unrelated old client credentials
  // cannot silently override the intended Shopify store configuration.
  if (staticToken) {
    return { token: staticToken, authMode: "static_admin_token" };
  }

  if (hasClientCredentialsConfigured()) {
    const now = Date.now();

    if (
      cachedAccessToken &&
      cachedAccessTokenExpiresAt &&
      now < cachedAccessTokenExpiresAt - 60_000
    ) {
      return { token: cachedAccessToken, authMode: "client_credentials_cached" };
    }

    const token = await fetchClientCredentialsToken(storeDomain);
    return { token, authMode: "client_credentials_fresh" };
  }

  throw new Error(
    "Missing Shopify credentials. Add SHOPIFY_ADMIN_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET."
  );
}

async function shopifyGraphQLRequest({ storeDomain, apiVersion, query, variables }) {
  let { token, authMode } = await getShopifyAccessToken(storeDomain);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });

    const raw = await response.text();
    let json;

    try {
      json = JSON.parse(raw);
    } catch {
      json = { raw };
    }

    if (response.status === 401 && hasClientCredentialsConfigured() && attempt === 0) {
      clearCachedAccessToken();
      const refreshed = await getShopifyAccessToken(storeDomain);
      token = refreshed.token;
      authMode = refreshed.authMode;
      continue;
    }

    return { status: response.status, json, authMode };
  }

  throw new Error("Shopify authentication retry failed");
}

function extractGraphQLErrors(response) {
  const topLevelErrors = Array.isArray(response.json?.errors)
    ? response.json.errors.map((error) => String(error?.message || "Unknown GraphQL error"))
    : [];

  const result = response.json?.data?.draftOrderCreate;
  const userErrors = Array.isArray(result?.userErrors) ? result.userErrors : [];

  return {
    topLevelErrors,
    userErrors,
    messages: [
      ...topLevelErrors,
      ...userErrors.map((error) => String(error?.message || "Unknown Shopify user error")),
    ],
  };
}

function isVariantRelatedError(messages) {
  return messages.some((message) =>
    /(variant|product variant).*(does not exist|not found|invalid|could not be found|is not available)|invalid.*variant/i.test(
      message
    )
  );
}

function moneyInput(cents, currencyCode) {
  return {
    amount: (cents / 100).toFixed(2),
    currencyCode,
  };
}

function createVariantLineItem({
  variantId,
  quantity,
  totalCents,
  currencyCode,
  properties,
}) {
  const unitCents = Math.max(1, Math.round(totalCents / quantity));

  return {
    variantId,
    quantity,
    customAttributes: getCustomAttributes(properties),
    priceOverride: moneyInput(unitCents, currencyCode),
  };
}

function createCustomLineItem({ title, quantity, totalCents, currencyCode, properties }) {
  const unitCents = Math.max(1, Math.round(totalCents / quantity));

  return {
    title,
    quantity,
    requiresShipping: true,
    taxable: true,
    originalUnitPriceWithCurrency: moneyInput(unitCents, currencyCode),
    customAttributes: getCustomAttributes(properties),
  };
}

async function createDraft({ storeDomain, apiVersion, currencyCode, lineItems }) {
  const mutation = `
    mutation DraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  return shopifyGraphQLRequest({
    storeDomain,
    apiVersion,
    query: mutation,
    variables: {
      input: {
        lineItems,
        presentmentCurrencyCode: currencyCode,
      },
    },
  });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8"));
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function configurationStatus() {
  const storeDomain = sanitizeStoreDomain(process.env.SHOPIFY_STORE_DOMAIN);
  const hasStaticToken = Boolean(String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim());
  const hasClientCredentials = hasClientCredentialsConfigured();
  const storeDomainValid = Boolean(storeDomain && /\.myshopify\.com$/i.test(storeDomain));
  const authConfigured = hasStaticToken || hasClientCredentials;

  return {
    ok: storeDomainValid && authConfigured,
    service: "island-murphy-beds-draft-checkout",
    api_version: String(process.env.SHOPIFY_API_VERSION || "2026-01").trim(),
    currency: String(process.env.DEFAULT_CURRENCY_CODE || "CAD").trim().toUpperCase(),
    store_domain_configured: Boolean(storeDomain),
    store_domain_valid: storeDomainValid,
    authentication_configured: authConfigured,
    authentication_mode: hasStaticToken
      ? "static_admin_token"
      : hasClientCredentials
        ? "client_credentials"
        : "missing",
    custom_line_fallback_enabled: process.env.ALLOW_CUSTOM_LINE_FALLBACK !== "false",
    message:
      storeDomainValid && authConfigured
        ? "Configuration is present. Run a Shopify storefront checkout test."
        : "Add valid Shopify environment variables in Vercel and redeploy.",
  };
}

module.exports = async function handler(req, res) {
  try {
    const method = String(req.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      applyCors(req, res);
      res.statusCode = 204;
      return res.end();
    }

    if (method === "GET") {
      const status = configurationStatus();
      return sendJson(req, res, status.ok ? 200 : 503, status);
    }

    if (method !== "POST") {
      return sendJson(req, res, 405, {
        ok: false,
        code: "METHOD_NOT_ALLOWED",
        errors: ["Use GET, POST, or OPTIONS"],
      });
    }

    const origin = req.headers?.origin || null;
    const allowedOrigins = getAllowedOrigins();

    if (origin && !allowedOrigins.has(origin)) {
      return sendJson(req, res, 403, {
        ok: false,
        code: "ORIGIN_NOT_ALLOWED",
        errors: ["Origin not allowed"],
      });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(req, res, 400, {
        ok: false,
        code: "INVALID_JSON",
        errors: ["Invalid JSON body"],
      });
    }

    const variantIdRaw = body.variantId ?? body.variantID ?? body.variant_id;
    const variantId = formatVariantGid(variantIdRaw);
    const quantity = toPositiveInt(body.quantity, 1);
    const properties =
      body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)
        ? body.properties
        : {};

    const currencyCode = String(
      body.currencyCode || process.env.DEFAULT_CURRENCY_CODE || "CAD"
    )
      .trim()
      .toUpperCase();

    const basePriceCents = toNonNegativeInt(body.basePriceCents, 0);
    const legacyPriceCents = dollarsToCents(body.price);
    const finalTotalCents = toNonNegativeInt(
      body.finalTotalCents,
      legacyPriceCents || basePriceCents
    );
    const customizationPriceCents = toNonNegativeInt(
      body.customizationPriceCents,
      Math.max(0, finalTotalCents - basePriceCents)
    );

    const title = String(body.title || "Murphy Bed (Customizable)").trim() ||
      "Murphy Bed (Customizable)";

    const allowCustomLineFallback =
      body.allowCustomLineFallback !== false &&
      process.env.ALLOW_CUSTOM_LINE_FALLBACK !== "false";

    if (finalTotalCents <= 0) {
      return sendJson(req, res, 400, {
        ok: false,
        code: "INVALID_TOTAL",
        errors: ["finalTotalCents must be greater than zero"],
      });
    }

    const storeDomain = sanitizeStoreDomain(process.env.SHOPIFY_STORE_DOMAIN);
    const apiVersion = String(process.env.SHOPIFY_API_VERSION || "2026-01").trim();

    if (!storeDomain) {
      return sendJson(req, res, 500, {
        ok: false,
        code: "MISSING_STORE_DOMAIN",
        errors: ["Missing SHOPIFY_STORE_DOMAIN"],
      });
    }

    if (!/\.myshopify\.com$/i.test(storeDomain)) {
      return sendJson(req, res, 500, {
        ok: false,
        code: "INVALID_STORE_DOMAIN",
        errors: [
          "SHOPIFY_STORE_DOMAIN must be the permanent .myshopify.com domain, not the public custom domain",
        ],
      });
    }

    let checkoutMode = "variant_price_override";
    let shopifyResponse;

    if (variantId) {
      shopifyResponse = await createDraft({
        storeDomain,
        apiVersion,
        currencyCode,
        lineItems: [
          createVariantLineItem({
            variantId,
            quantity,
            totalCents: finalTotalCents,
            currencyCode,
            properties,
          }),
        ],
      });

      const errors = extractGraphQLErrors(shopifyResponse);

      if (
        (shopifyResponse.status >= 400 || errors.messages.length > 0) &&
        allowCustomLineFallback &&
        isVariantRelatedError(errors.messages)
      ) {
        checkoutMode = "custom_line_variant_fallback";
        shopifyResponse = await createDraft({
          storeDomain,
          apiVersion,
          currencyCode,
          lineItems: [
            createCustomLineItem({
              title,
              quantity,
              totalCents: finalTotalCents,
              currencyCode,
              properties,
            }),
          ],
        });
      }
    } else if (allowCustomLineFallback) {
      checkoutMode = "custom_line_missing_variant_fallback";
      shopifyResponse = await createDraft({
        storeDomain,
        apiVersion,
        currencyCode,
        lineItems: [
          createCustomLineItem({
            title,
            quantity,
            totalCents: finalTotalCents,
            currencyCode,
            properties,
          }),
        ],
      });
    } else {
      return sendJson(req, res, 400, {
        ok: false,
        code: "VARIANT_ID_REQUIRED",
        errors: ["A valid variantId is required and custom-line fallback is disabled"],
        configured_store: storeDomain,
      });
    }

    const { topLevelErrors, userErrors, messages } = extractGraphQLErrors(shopifyResponse);

    if (shopifyResponse.status >= 400 || topLevelErrors.length > 0) {
      return sendJson(req, res, 500, {
        ok: false,
        code: "SHOPIFY_GRAPHQL_ERROR",
        errors: messages.length
          ? messages
          : [`Shopify request failed with status ${shopifyResponse.status}`],
        configured_store: storeDomain,
        auth_mode: shopifyResponse.authMode,
      });
    }

    if (userErrors.length > 0) {
      return sendJson(req, res, 400, {
        ok: false,
        code: isVariantRelatedError(messages) ? "VARIANT_NOT_FOUND" : "DRAFT_ORDER_USER_ERROR",
        errors: messages,
        fields: userErrors.map((error) => error?.field || []),
        configured_store: storeDomain,
        received_variant_id: normalizeVariantNumericId(variantIdRaw),
        auth_mode: shopifyResponse.authMode,
      });
    }

    const result = shopifyResponse.json?.data?.draftOrderCreate;
    const invoiceUrl = result?.draftOrder?.invoiceUrl;

    if (!invoiceUrl) {
      return sendJson(req, res, 500, {
        ok: false,
        code: "INVOICE_URL_MISSING",
        errors: ["Draft order was created but Shopify did not return an invoice URL"],
        configured_store: storeDomain,
        auth_mode: shopifyResponse.authMode,
      });
    }

    return sendJson(req, res, 200, {
      ok: true,
      invoice_url: invoiceUrl,
      checkout_mode: checkoutMode,
      variant_id: normalizeVariantNumericId(variantIdRaw) || null,
      base_price_cents: basePriceCents,
      customization_price_cents: customizationPriceCents,
      final_total_cents: finalTotalCents,
      configured_store: storeDomain,
      auth_mode: shopifyResponse.authMode,
    });
  } catch (error) {
    console.error("Draft order route runtime error", error?.message || error);

    return sendJson(req, res, 500, {
      ok: false,
      code: "RUNTIME_ERROR",
      errors: [error?.message || "Internal Server Error"],
    });
  }
};
