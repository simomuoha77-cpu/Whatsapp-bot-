const { getDb, nextSequence } = require('./mongo');

async function getPricingSettings() {
  const db = await getDb();
  let doc = await db.collection('pricing_settings').find({}).sort({ id: 1 }).limit(1).next();
  if (doc) return doc;
  const id = await nextSequence('pricing_settings');
  doc = {
    id,
    monthly_price: 500,
    yearly_price: 5000,
    trial_days: 5,
    updated_at: new Date(),
  };
  await db.collection('pricing_settings').insertOne(doc);
  return doc;
}

async function updatePricingSettings({ monthlyPrice, yearlyPrice, trialDays }) {
  const db = await getDb();
  const current = await getPricingSettings();
  await db.collection('pricing_settings').updateOne(
    { id: current.id },
    { $set: {
        monthly_price: monthlyPrice,
        yearly_price: yearlyPrice,
        trial_days: trialDays,
        updated_at: new Date(),
    } }
  );
}

module.exports = { getPricingSettings, updatePricingSettings };
