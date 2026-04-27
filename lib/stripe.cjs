// stripe.cjs — minimal Stripe API + webhook helpers
//
// Hand-rolled to avoid the `stripe` npm dependency. Covers exactly the
// surface ccm-whatsapp uses: create a Checkout Session, retrieve a
// session, verify a webhook signature. The Stripe API is plain HTTP
// with form-encoded bodies, so this is a thin wrapper around fetch().
//
// Caller responsibilities:
//   - Pass the Stripe secret key (sk_live_… or sk_test_…) as `secretKey`
//   - Pass the webhook signing secret (whsec_…) as `webhookSecret` to
//     verifyWebhookSignature
//   - Pass GBP amounts as integers in pence (Stripe's minor-unit convention)

const crypto = require("node:crypto");

const STRIPE_API = "https://api.stripe.com/v1";

// Tolerance for clock skew on webhook timestamps. Stripe's recommended
// default is 5 minutes; same in their official SDK.
const SIGNATURE_TOLERANCE_SEC = 300;

async function _stripeRequest(method, pathSegment, body, { secretKey } = {}) {
  if (!secretKey) throw new Error("Stripe secretKey not configured");
  const headers = {
    "Authorization": `Bearer ${secretKey}`,
    "Stripe-Version": "2024-06-20",
  };
  const opts = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = _flattenForm(body);
  }
  const resp = await fetch(`${STRIPE_API}${pathSegment}`, opts);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Stripe ${method} ${pathSegment} failed (HTTP ${resp.status}): ${json?.error?.message || "unknown"}`);
    err.code = json?.error?.code || `http_${resp.status}`;
    err.statusCode = resp.status;
    err.stripeError = json?.error;
    throw err;
  }
  return json;
}

// Stripe expects nested params encoded as `parent[child]=value`.
function _flattenForm(obj, prefix = "") {
  const params = new URLSearchParams();
  function walk(value, key) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${key}[${i}]`));
    } else if (typeof value === "object") {
      for (const k of Object.keys(value)) walk(value[k], `${key}[${k}]`);
    } else {
      params.append(key, String(value));
    }
  }
  for (const k of Object.keys(obj)) walk(obj[k], prefix ? `${prefix}[${k}]` : k);
  return params.toString();
}

// Create a Checkout Session for a fixed-amount one-time payment.
//   amountPence     — amount in pence (e.g. £25 = 2500)
//   currency        — "gbp" (lowercase 3-letter ISO)
//   productName     — e.g. "HOKO Coder credit £25"
//   successUrl      — where Stripe redirects after payment (use a bare
//                     wa.me link to your bot since users are on mobile)
//   cancelUrl       — same shape, for cancel-then-return
//   clientReference — opaque correlation ID stored as
//                     `client_reference_id` on the session; we use the
//                     user's WhatsApp JID so the webhook can credit them
//   metadata        — extra fields stored on the session, mostly for
//                     audit / debugging
async function createCheckoutSession({ amountPence, currency, productName, successUrl, cancelUrl, clientReference, metadata, secretKey }) {
  return _stripeRequest("POST", "/checkout/sessions", {
    mode: "payment",
    payment_method_types: ["card"],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: clientReference,
    metadata: metadata || {},
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: amountPence,
        product_data: { name: productName },
      },
    }],
  }, { secretKey });
}

async function retrieveSession(sessionId, { secretKey } = {}) {
  return _stripeRequest("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`, null, { secretKey });
}

// Verify a `Stripe-Signature` header against the raw request body
// using the HMAC scheme Stripe documents. Returns true on match,
// throws on bad input or skew.
//
// Implementing this ourselves lets us avoid the `stripe` SDK while
// preserving timing-safe comparison and replay protection.
function verifyWebhookSignature({ rawBody, signatureHeader, webhookSecret, toleranceSec }) {
  if (!webhookSecret) throw new Error("webhookSecret not configured");
  if (typeof rawBody !== "string") throw new Error("rawBody must be a string (the exact bytes received from Stripe)");
  if (!signatureHeader) throw new Error("missing Stripe-Signature header");
  const tolerance = Number.isFinite(toleranceSec) ? toleranceSec : SIGNATURE_TOLERANCE_SEC;

  const parts = {};
  for (const item of signatureHeader.split(",")) {
    const idx = item.indexOf("=");
    if (idx === -1) continue;
    const k = item.slice(0, idx).trim();
    const v = item.slice(idx + 1).trim();
    if (!parts[k]) parts[k] = [];
    parts[k].push(v);
  }
  const ts = Number(parts.t?.[0]);
  const signatures = parts.v1 || [];
  if (!ts || signatures.length === 0) throw new Error("malformed Stripe-Signature header");
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > tolerance) {
    throw new Error("webhook timestamp outside tolerance — possible replay attack");
  }
  const signedPayload = `${ts}.${rawBody}`;
  const expected = crypto.createHmac("sha256", webhookSecret).update(signedPayload, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  for (const sig of signatures) {
    let sigBuf;
    try { sigBuf = Buffer.from(sig, "hex"); } catch { continue; }
    if (sigBuf.length !== expectedBuf.length) continue;
    if (crypto.timingSafeEqual(sigBuf, expectedBuf)) return true;
  }
  throw new Error("no matching signature");
}

module.exports = {
  createCheckoutSession,
  retrieveSession,
  verifyWebhookSignature,
};
