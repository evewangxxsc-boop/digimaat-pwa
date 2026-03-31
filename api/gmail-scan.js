// DigiMaat — Gmail Scan Serverless Function
// Handles both OAuth callback (GET) and Gmail fetch (POST)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://digimaat-pwa.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: OAuth callback — receive code, pass to parent window ──
  if (req.method === 'GET') {
    const { code, state, error } = req.query;

    if (error) {
      return res.send(`<html><body><script>
        window.opener&&window.opener.postMessage({type:'gmail_auth_error',error:'${error}'},'*');
        window.close();
      </script></body></html>`);
    }

    if (code) {
      return res.send(`<html><body><script>
        window.opener&&window.opener.postMessage({
          type:'gmail_auth_code',
          code:${JSON.stringify(code)},
          state:${JSON.stringify(state||'')}
        },'*');
        window.close();
      </script><p>Connecting to DigiMaat...</p></body></html>`);
    }

    return res.status(400).send('Missing code');
  }

  // ── POST: Fetch Gmail messages using auth code OR stored access token ──
  if (req.method === 'POST') {
    const { code, access_token: storedToken, dateFrom, dateTo } = req.body;

    if (!code && !storedToken) return res.status(400).json({ error: 'Missing authorization code or access token' });

    try {
      let accessToken = storedToken || null;
      let newToken = null;

      if (code) {
        // Exchange one-time auth code for access token
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id:     process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri:  'https://digimaat-pwa.vercel.app/api/gmail-scan',
            grant_type:    'authorization_code',
          }),
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return res.status(401).json({ error: 'Token exchange failed', detail: tokenData.error_description });
        }
        accessToken = tokenData.access_token;
        newToken = accessToken; // will be returned to browser for storage
      }

      // Build Gmail search query — no folder restriction, scan all mail
      let query = '';
      if (dateFrom) query += `after:${dateFrom.replace(/-/g,'/')}`;
      if (dateTo)   query += (query ? ' ' : '') + `before:${dateTo.replace(/-/g,'/')}`;
      if (!query)   query = 'in:anywhere';

      // List messages
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(query)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const listData = await listRes.json();

      if (!listData.messages || listData.messages.length === 0) {
        return res.status(200).json({ messages: [], total: 0 });
      }

      // Fetch metadata only — From, Subject, Date — never message body
      const messages = await Promise.all(
        listData.messages.slice(0, 50).map(async (msg) => {
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const msgData = await msgRes.json();
          const headers = msgData.payload?.headers || [];
          const h = (n) => headers.find(x => x.name.toLowerCase()===n.toLowerCase())?.value||'';
          return {
            id:      msg.id,
            from:    h('From'),
            subject: h('Subject'),
            date:    h('Date'),
            snippet: msgData.snippet || '',
          };
        })
      );

      // Return token if freshly exchanged so browser can store it for reuse
      const resp = { messages, total: listData.resultSizeEstimate || messages.length };
      if (newToken) resp.access_token = newToken;
      return res.status(200).json(resp);

    } catch (err) {
      console.error('Gmail scan error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
