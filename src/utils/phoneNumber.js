// People type phone numbers the way they'd dial locally — for Kenyan
// numbers that's usually a leading 0 (e.g. "0712345678"), not the full
// international format WhatsApp actually needs ("254712345678"). Sending
// the local form straight through to requestPairingCode() produces a
// pairing code for the wrong/garbled number, which WhatsApp rejects with
// "Couldn't link device" — a formatting problem that looks like a
// connection bug but isn't one.
//
// defaultCountryCode is applied only when the number looks like a local
// Kenyan number (starts with 0, 10 digits total) — anything already in
// international form (no leading 0, or already starts with a country
// code) is passed through untouched.
function normalizePhoneNumber(raw, defaultCountryCode = '254') {
  const digits = (raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('0') && digits.length === 10) {
    return defaultCountryCode + digits.slice(1);
  }
  return digits;
}

module.exports = { normalizePhoneNumber };
