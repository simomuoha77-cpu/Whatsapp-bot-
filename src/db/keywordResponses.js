const { getDb, nextSequence } = require('./mongo');

async function addKeywordResponse(botId, keyword, response) {
  const db = await getDb();
  const id = await nextSequence('keyword_responses');
  const doc = {
    id,
    bot_id: Number(botId),
    keyword: keyword.toLowerCase().trim(),
    response,
    is_active: true,
    created_at: new Date(),
  };
  await db.collection('keyword_responses').insertOne(doc);
  return doc;
}

async function getKeywordResponses(botId) {
  const db = await getDb();
  return db.collection('keyword_responses')
    .find({ bot_id: Number(botId), is_active: true })
    .sort({ created_at: 1 })
    .toArray();
}

async function getAllKeywordResponses(botId) {
  const db = await getDb();
  return db.collection('keyword_responses')
    .find({ bot_id: Number(botId) })
    .sort({ created_at: -1 })
    .toArray();
}

async function deleteKeywordResponse(id) {
  const db = await getDb();
  await db.collection('keyword_responses').deleteOne({ id: Number(id) });
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
