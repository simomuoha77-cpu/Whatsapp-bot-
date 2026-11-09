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
    tutorial_url: null,
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

// Separate from updatePricingSettings so admins can update the tutorial
// link without needing to also touch pricing (and vice versa).
async function updateTutorialUrl(tutorialUrl) {
  const db = await getDb();
  const current = await getPricingSettings();
  await db.collection('pricing_settings').updateOne(
    { id: current.id },
    { $set: { tutorial_url: tutorialUrl || null, updated_at: new Date() } }
  );
}

module.exports = { getPricingSettings, updatePricingSettings, updateTutorialUrl };
