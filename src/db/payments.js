const { getDb, nextSequence } = require('./mongo');

async function createPaymentRecord({ botId, checkoutRequestId, merchantRequestId, phoneNumber, amount, plan, purpose = 'subscription', vpnDay = null, vpnTitle = null, vpnUri = null, vpnUris = null, vpnReservationId = null, vpnQuantity = 1 }) {
  const db = await getDb();
  const id = await nextSequence('payments');
  const doc = {
    id,
    bot_id: Number(botId),
    checkout_request_id: checkoutRequestId,
    merchant_request_id: merchantRequestId || null,
    phone_number: phoneNumber,
    amount,
    plan,
    purpose,
    vpn_day: vpnDay,
    vpn_title: vpnTitle,
    vpn_uri: vpnUri,
    vpn_uris: Array.isArray(vpnUris) ? vpnUris : null,
    vpn_reservation_id: vpnReservationId,
    vpn_quantity: Number(vpnQuantity || 1),
    status: 'pending',
    mpesa_receipt_number: null,
    result_desc: null,
    created_at: new Date(),
    completed_at: null,
  };
  await db.collection('payments').insertOne(doc);
  return doc;
}

async function getPaymentByCheckoutId(checkoutRequestId) {
  const db = await getDb();
  return db.collection('payments').findOne({ checkout_request_id: checkoutRequestId });
}

async function markPaymentResult(checkoutRequestId, { status, mpesaReceiptNumber, resultDesc }) {
  const db = await getDb();
  await db.collection('payments').updateOne(
    { checkout_request_id: checkoutRequestId },
    { $set: {
        status,
        mpesa_receipt_number: mpesaReceiptNumber || null,
        result_desc: resultDesc || null,
        completed_at: new Date(),
    } }
  );
}

async function getPaymentsForBot(botId, limit = 20) {
  const db = await getDb();
  return db.collection('payments')
    .find({ bot_id: Number(botId) })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  createPaymentRecord,
  getPaymentByCheckoutId,
  markPaymentResult,
  getPaymentsForBot,
};
