const fetch = require('node-fetch');

let cachedToken = null;
let tokenExpiresAt = 0;

function makeRequestId() {
  return Math.random().toString(36).slice(2, 10);
}

async function fetchTextSafe(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function getAccessToken(requestId) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch('https://api.kajabi.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.KAJABI_CLIENT_ID,
      client_secret: process.env.KAJABI_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    const t = await fetchTextSafe(res);
    throw new Error(`[${requestId}] OAuth token failed (HTTP ${res.status}): ${t}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000; // expire 5 min early
  return cachedToken;
}

async function findContactByEmail(token, email, requestId) {
  const url =
    'https://api.kajabi.com/v1/contacts?filter%5Bsite_id%5D=' +
    process.env.KAJABI_SITE_ID +
    '&filter%5Bsearch%5D=' +
    encodeURIComponent(email);

  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
    },
  });

  if (!res.ok) {
    const t = await fetchTextSafe(res);
    throw new Error(`[${requestId}] Contact search failed (HTTP ${res.status}): ${t}`);
  }

  const data = await res.json();
  const arr = Array.isArray(data.data) ? data.data : [];

  return (
    arr.find((c) => (c.attributes?.email || '').toLowerCase() === email.toLowerCase()) || null
  );
}

async function createContact(token, email, requestId) {
  const res = await fetch('https://api.kajabi.com/v1/contacts', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'contacts',
        attributes: { email, subscribed: true },
        relationships: {
          site: { data: { type: 'sites', id: process.env.KAJABI_SITE_ID } },
        },
      },
    }),
  });

  if (!res.ok) {
    const t = await fetchTextSafe(res);
    throw new Error(`[${requestId}] Create contact failed (HTTP ${res.status}): ${t}`);
  }

  return await res.json();
}

// Optional but recommended: ensure existing contacts become subscribed
async function ensureSubscribed(token, contactId, requestId) {
  const res = await fetch(`https://api.kajabi.com/v1/contacts/${contactId}`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'contacts',
        id: String(contactId),
        attributes: { subscribed: true },
      },
    }),
  });

  if (!res.ok) {
    const t = await fetchTextSafe(res);
    throw new Error(`[${requestId}] Ensure subscribed failed (HTTP ${res.status}): ${t}`);
  }
}

async function addTagToContact(token, contactId, tagId, requestId) {
  const url = `https://api.kajabi.com/v1/contacts/${contactId}/relationships/tags`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: [{ type: 'contact_tags', id: String(tagId) }],
    }),
  });

  if (!res.ok) {
    const t = await fetchTextSafe(res);

    // Treat common "already tagged" responses as success
    if (
      res.status === 409 ||
      res.status === 422 ||
      (res.status === 400 && /already|exists|taken/i.test(t))
    ) {
      return { ok: true, alreadyTagged: true };
    }

    throw new Error(`[${requestId}] Add tag failed (HTTP ${res.status}): ${t}`);
  }

  return await res.json();
}

module.exports = async (req, res) => {
  const requestId = makeRequestId();

  // CORS + no caching
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed', requestId });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // NOTE: must be "let" because we overwrite with cleaned values
    let email = (body?.email || '').trim();
    let tag = (body?.tag || '').trim();

    // --- EMAIL GATEKEEPER (blocks junk before Kajabi sees it) ---
    const emailClean = String(email || '').trim().toLowerCase();
    const tagClean = String(tag || '').trim().toLowerCase();

    // 1) Require both
    if (!emailClean || !tagClean) {
      return res.status(400).json({ ok: false, error: 'Missing email or tag', requestId });
    }

    // 2) Strong “looks like an email” check (blocks obvious junk)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRegex.test(emailClean)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.', requestId });
    }

    // 3) Block test/reserved domains (Kajabi may reject anyway)
    const blockedDomains = new Set(['example.com', 'example.net', 'example.org']);
    const domain = emailClean.split('@')[1] || '';
    if (blockedDomains.has(domain)) {
      return res.status(400).json({
        ok: false,
        error: 'Please use a real email address (not example.com).',
        requestId
      });
    }

    // Overwrite with cleaned values for the rest of the function
    email = emailClean;
    tag = tagClean;
    // --- END EMAIL GATEKEEPER ---

    const tagMap = {
      contractor: process.env.KAJABI_TAG_ID_CONTRACTOR,
      diy: process.env.KAJABI_TAG_ID_DIY,
      waitlist: process.env.KAJABI_TAG_ID_WAITLIST,
    };

    const tagId = tagMap[tag];
    if (!tagId) {
      return res.status(400).json({ ok: false, error: 'Invalid tag', requestId });
    }

    let token = await getAccessToken(requestId);

    // Find contact (retry token once if stale)
    let contact = null;
    try {
      contact = await findContactByEmail(token, email, requestId);
    } catch (e) {
      if (String(e.message || '').includes('HTTP 401')) {
        cachedToken = null;
        tokenExpiresAt = 0;
        token = await getAccessToken(requestId);
        contact = await findContactByEmail(token, email, requestId);
      } else {
        throw e;
      }
    }

    if (!contact) {
      const created = await createContact(token, email, requestId);
      contact = created.data;
    } else {
      // Optional but recommended
      await ensureSubscribed(token, contact.id, requestId);
    }

    await addTagToContact(token, contact.id, tagId, requestId);

    return res.status(200).json({ ok: true, requestId });
  } catch (err) {
    console.error('Kajabi tag error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err), requestId });
  }
};
