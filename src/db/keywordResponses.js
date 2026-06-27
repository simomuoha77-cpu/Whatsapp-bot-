const { query } = require('./pool');

async function addKeywordResponse(botId, keyword, response) {
  const res = await query(
    `INSERT INTO keyword_responses (bot_id, keyword, response) VALUES ($1, $2, $3) RETURNING *`,
    [botId, keyword.toLowerCase().trim(), response]
  );
  return res.rows[0];
}

async function getKeywordResponses(botId) {
  const res = await query(
    'SELECT * FROM keyword_responses WHERE bot_id = $1 AND is_active = TRUE ORDER BY created_at ASC',
    [botId]
  );
  return res.rows;
}

async function getAllKeywordResponses(botId) {
  const res = await query(
    'SELECT * FROM keyword_responses WHERE bot_id = $1 ORDER BY created_at DESC',
    [botId]
  );
  return res.rows;
}

async function deleteKeywordResponse(id) {
  await query('DELETE FROM keyword_responses WHERE id = $1', [id]);
}

/**
 * Finds the first keyword response whose keyword appears as a substring
 * of the given text (case-insensitive). Returns null if no match.
 */
function matchKeyword(responses, text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  return responses.find((r) => lower.includes(r.keyword)) || null;
}

module.exports = {
  addKeywordResponse,
  getKeywordResponses,
  getAllKeywordResponses,
  deleteKeywordResponse,
  matchKeyword,
};
