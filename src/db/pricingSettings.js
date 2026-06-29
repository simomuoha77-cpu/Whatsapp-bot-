const { query } = require('./pool');

async function getPricingSettings() {
  const res = await query('SELECT * FROM pricing_settings ORDER BY id ASC LIMIT 1');
  if (res.rows[0]) return res.rows[0];
  const insert = await query(
    `INSERT INTO pricing_settings (monthly_price, yearly_price, trial_days)
     VALUES (500, 5000, 5) RETURNING *`
  );
  return insert.rows[0];
}

async function updatePricingSettings({ monthlyPrice, yearlyPrice, trialDays }) {
  const current = await getPricingSettings();
  await query(
    `UPDATE pricing_settings SET monthly_price = $1, yearly_price = $2, trial_days = $3, updated_at = NOW() WHERE id = $4`,
    [monthlyPrice, yearlyPrice, trialDays, current.id]
  );
}

module.exports = { getPricingSettings, updatePricingSettings };
