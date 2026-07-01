const logger = require('./logger');

/**
 * Calls Groq's OpenAI-compatible chat completions endpoint.
 * https://api.groq.com/openai/v1/chat/completions
 */
async function callGroq(systemPrompt, history, userMessage) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: userMessage },
  ];

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages,
      max_completion_tokens: 512,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

/**
 * Calls Google's Gemini generateContent endpoint.
 * https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 */
async function callGemini(systemPrompt, history, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const contents = [
    ...history.map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text).join('').trim() || null;
}

/**
 * Generates an AI reply using whichever provider the bot is configured for.
 * Returns the reply text, or null if generation failed (caller should
 * fall back to a generic response rather than going silent).
 */
async function generateAiReply({ provider, systemPrompt, history, userMessage, botId }) {
  try {
    if (provider === 'gemini') {
      return await callGemini(systemPrompt, history, userMessage);
    }
    return await callGroq(systemPrompt, history, userMessage); // default: groq
  } catch (err) {
    logger.error({ err, botId, provider }, 'AI provider call failed');
    return null;
  }
}

module.exports = { generateAiReply };
