// DigiMaat — Claude AI Scam Check (server-side, Option B)
// Rate limit: 10 checks per IP per day (in-memory, resets on cold start)

const ipCounts = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://digimaat-pwa.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, lang } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Missing text' });

  // ── Rate limiting by IP (10 per day) ──────────────────────
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || req.socket?.remoteAddress
             || 'unknown';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `${ip}:${today}`;
  const count = ipCounts.get(key) || 0;

  if (count >= 10) {
    return res.status(429).json({
      error: 'Daily limit reached',
      limitReached: true,
      checksRemaining: 0,
    });
  }

  ipCounts.set(key, count + 1);
  const checksRemaining = 10 - count - 1;

  // ── Validate API key is configured ────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });

  // ── Truncate to 500 chars — minimise data exposure ────────
  const truncated = text.substring(0, 500);

  // ── Build prompt (bilingual) ───────────────────────────────
  const system = lang === 'nl'
    ? 'Je bent DigiMaat, een digitale veiligheidsassistent voor Nederlandse senioren. Analyseer het bericht op oplichting. Focus op: nep-Belastingdienst, nep-DigiD, bankfraude, nep-PostNL, urgentietactieken, cryptocurrency-fraude. Geef je antwoord ALLEEN als JSON: {"verdict":"LIKELY_SCAM"|"SUSPICIOUS"|"SAFE","explanation":"max 2 zinnen in eenvoudig Nederlands","flags":["reden1","reden2"]}'
    : 'You are DigiMaat, a digital safety assistant for Dutch seniors. Analyse this message for scam indicators. Focus on: fake Belastingdienst, fake DigiD, bank fraud, fake PostNL, urgency tactics, prize scams, crypto fraud, phishing. Reply ONLY as JSON: {"verdict":"LIKELY_SCAM"|"SUSPICIOUS"|"SAFE","explanation":"max 2 plain sentences","flags":["reason1","reason2"]}';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: truncated }],
      }),
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    return res.status(200).json({ ...result, checksRemaining });

  } catch (err) {
    console.error('Claude check error:', err);
    return res.status(500).json({ error: 'Analysis failed' });
  }
}
