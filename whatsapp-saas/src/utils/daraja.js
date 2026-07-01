const logger = require('./logger');

const BASE_URL = process.env.DARAJA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Fetches (and caches) an OAuth access token. Daraja tokens are valid for
 * about an hour — we cache and reuse rather than requesting a fresh one
 * per call, since unnecessary token requests are a common cause of
 * rate-limit issues per Safaricom's own guidance.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    throw new Error('DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET not set');
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Daraja OAuth failed ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Refresh 5 minutes early to avoid edge-of-expiry failures.
  tokenExpiresAt = Date.now() + (parseInt(data.expires_in, 10) - 300) * 1000;
  return cachedToken;
}

function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function normalizePhoneNumber(phone) {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return '254' + digits.slice(1);
  if (digits.startsWith('7') || digits.startsWith('1')) return '254' + digits;
  return digits;
}

/**
 * Initiates an STK Push (Lipa na M-Pesa Online) payment request.
 * Returns Safaricom's acknowledgement, which includes CheckoutRequestID —
 * the actual payment result arrives later via the callback URL.
 */
async function initiateStkPush({ phoneNumber, amount, accountReference, transactionDesc, callbackUrl }) {
  const shortcode = process.env.DARAJA_SHORTCODE;
  const passkey = process.env.DARAJA_PASSKEY;
  if (!shortcode || !passkey) {
    throw new Error('DARAJA_SHORTCODE / DARAJA_PASSKEY not set');
  }

  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  const body = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: normalizedPhone,
    PartyB: shortcode,
    PhoneNumber: normalizedPhone,
    CallBackURL: callbackUrl,
    AccountReference: accountReference.slice(0, 12), // Daraja limits this field's length
    TransactionDesc: transactionDesc.slice(0, 13),
  };

  const res = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.errorCode) {
    logger.error({ status: res.status, data }, 'STK Push request failed');
    throw new Error(data.errorMessage || `STK Push failed with status ${res.status}`);
  }

  return data; // contains MerchantRequestID, CheckoutRequestID, ResponseCode, etc.
}

/**
 * Parses a Daraja STK callback body into a simple, flat shape.
 * Safaricom's CallbackMetadata.Item array needs to be unpacked manually.
 */
function parseStkCallback(body) {
  const callback = body?.Body?.stkCallback;
  if (!callback) return null;

  const result = {
    merchantRequestId: callback.MerchantRequestID,
    checkoutRequestId: callback.CheckoutRequestID,
    resultCode: callback.ResultCode,
    resultDesc: callback.ResultDesc,
    success: callback.ResultCode === 0,
    amount: null,
    mpesaReceiptNumber: null,
    phoneNumber: null,
  };

  const items = callback.CallbackMetadata?.Item || [];
  for (const item of items) {
    if (item.Name === 'Amount') result.amount = item.Value;
    if (item.Name === 'MpesaReceiptNumber') result.mpesaReceiptNumber = item.Value;
    if (item.Name === 'PhoneNumber') result.phoneNumber = item.Value;
  }

  return result;
}

module.exports = { initiateStkPush, parseStkCallback };
