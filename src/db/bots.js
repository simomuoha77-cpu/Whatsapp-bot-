const crypto = require('crypto');
const { query } = require('./pool');

function generateSlug() {
  return crypto.randomBytes(6).toString('hex'); // e.g. "a1b2c3d4e5f6"
}

async function createBot(clientName) {
  let slug = generateSlug();
  // Extremely unlikely to collide, but guard anyway since slug is unique.
  let attempts = 0;
  while (attempts < 5) {
    try {
      const res = await query(
        `INSERT INTO bots (slug, client_name, status) VALUES ($1, $2, 'pending') RETURNING *`,
        [slug, clientName || null]
      );
      // Create a default feature row immediately so toggles always have something to update.
      await query(`INSERT INTO bot_features (bot_id) VALUES ($1)`, [res.rows[0].id]);
      return res.rows[0];
    } catch (err) {
      if (err.code === '23505') { // unique violation, regenerate and retry
        slug = generateSlug();
        attempts++;
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to generate a unique bot slug after several attempts.');
}

async function getBotBySlug(slug) {
  const res = await query('SELECT * FROM bots WHERE slug = $1', [slug]);
  return res.rows[0] || null;
}

async function getBotById(id) {
  const res = await query('SELECT * FROM bots WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getAllBots() {
  const res = await query('SELECT * FROM bots ORDER BY created_at DESC');
  return res.rows;
}

async function deleteBot(id) {
  await query('DELETE FROM bots WHERE id = $1', [id]); // cascades to all related tables
}

async function renameBot(id, clientName) {
  await query('UPDATE bots SET client_name = $1 WHERE id = $2', [clientName, id]);
}

module.exports = {
  createBot,
  getBotBySlug,
  getBotById,
  getAllBots,
  deleteBot,
  renameBot,
};
