module.exports = async (req, res) => }
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { email, tag, turnstileToken } = req.body;

    if (!email || !tag) {
      return res.status(400).json({ ok: false, error: 'Missing email or tag' });
    }

    if (!turnstileToken) {
      return res.status(400).json({ ok: false, error: 'Missing verification token' });
    }

    // Step 1: Verify Turnstile token
    const turnstileRes = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET_KEY,
          response: turnstileToken,
        }),
      }
    );

    const turnstileData = await turnstileRes.json();

    if (!turnstileData.success) {
      return res.status(403).json({ ok: false, error: 'Bot detected' });
    }

    // Step 2: Map tag to MailerLite group ID
    const groupMap = {
      contractor: process.env.MAILERLITE_GROUP_PVCONTRACTOR,
      diy: process.env.MAILERLITE_GROUP_DIY,
      waitlist: process.env.MAILERLITE_GROUP_WAITLIST,
    };

    const groupId = groupMap[tag];
    if (!groupId) {
      return res.status(400).json({ ok: false, error: 'Invalid tag' });
    }

    // Step 3: Create/update subscriber in MailerLite
    const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.MAILERLITE_API_TOKEN,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email: email,
        groups: [groupId],
      }),
    });

    if (!mlRes.ok) {
      const errorBody = await mlRes.text();
      throw new Error('MailerLite error:
