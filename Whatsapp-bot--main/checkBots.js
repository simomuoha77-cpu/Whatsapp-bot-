require('dotenv').config();
const { getDb } = require('./src/db/mongo');

async function main() {
  const db = await getDb();
  const bots = await db.collection('bots').find({}).toArray();
  console.log(`Total bots: ${bots.length}`);
  for (const bot of bots) {
    console.log({
      id: bot.id,
      phone_number: bot.phone_number,
      status: bot.status,
      slug: bot.slug,
      created_at: bot.created_at,
    });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to query bots:', err);
  process.exit(1);
});
