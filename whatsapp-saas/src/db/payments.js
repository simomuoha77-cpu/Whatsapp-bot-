const { query } = require('./pool');

async function createPaymentRecord({ botId, checkoutRequestId, merchantRequestId, phoneNumber, amount, plan }) {
  const res = await query(
    `INSERT INTO payments (bot_id, checkout_request_id, merchant_request_id, phone_number, amount, plan)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [botId, checkoutRequestId, merchantRequestId || null, phoneNumber, amount, plan]
  );
  return res.rows[0];
}

async function getPaymentByCheckoutId(checkoutRequestId) {
  const res = await query('SELECT * FROM payments WHERE checkout_request_id = $1', [checkoutRequestId]);
  return res.rows[0] || null;
}

async function markPaymentResult(checkoutRequestId, { status, mpesaReceiptNumber, resultDesc }) {
  await query(
    `UPDATE payments SET status = $2, mpesa_receipt_number = $3, result_desc = $4, completed_at = NOW()
     WHERE checkout_request_id = $1`,
    [checkoutRequestId, status, mpesaReceiptNumber || null, resultDesc || null]
  );
}

async function getPaymentsForBot(botId, limit = 20) {
  const res = await query(
    'SELECT * FROM payments WHERE bot_id = $1 ORDER BY created_at DESC LIMIT $2',
    [botId, limit]
  );
  return res.rows;
}

module.exports = {
  createPaymentRecord,
  getPaymentByCheckoutId,
  markPaymentResult,
  getPaymentsForBot,
};
