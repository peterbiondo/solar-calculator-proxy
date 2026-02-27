const fetch = require('node-fetch');

// Cache the access token so we don't request a new one every time
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // If we have a valid cached token, use it
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const response = await fetch('https://api.kajabi.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.KAJABI_CLIENT_ID,
      client_secret: process.env.KAJABI_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to get Kajabi access token');
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Expire 5 minutes early to be safe
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}

async function findContactByEmail(token, email) {
  const url =
    'https://api.kajabi.com/v1/contacts?filter%5Bsite_id%5D=' +
    process.env.KAJABI_SITE_ID +
    '&filter%5Bsearch%5D=' +
    encodeURIComponent(email);

  const response = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to search contacts');
  }

  const data = await response.json();

  // Kajabi search is fuzzy, so we must exact-match the email ourselves
  const match = data.data.find(
    (contact) => contact.attributes.email.toLowerCase() === email.toLowerCase()
  );

  return match || null;
}

async function createContact(token, email) {
  const response = await fetch('https://api.kajabi.com/v1/contacts', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'contacts',
        attributes: {
          email: email,
          subscribed: true,
        },
        relationships: {
          site: {
            data: {
              type: 'sites',
              id: process.env.KAJABI_SITE_ID,
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error('Failed to create contact: ' + errorBody);
  }

  return await response.json();
}

async function addTagToContact(token, contactId, tagId) {
  const url =
    'https://api.kajabi.com/v1/contacts/' + contactId + '/relationships/tags';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: [
        {
          type: 'contact_tags',
          id: tagId,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error('Failed to add tag: ' + errorBody);
  }

  return await response.json();
}

module.exports = async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Allow requests from your site
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { email, tag } = req.body;

    // Validate email
    if (!email || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email required' });
    }

    // Map tag name to the tag ID stored in environment variables
    const tagMap = {
      contractor: process.env.KAJABI_TAG_ID_CONTRACTOR,
      diy: process.env.KAJABI_TAG_ID_DIY,
      waitlist: process.env.KAJABI_TAG_ID_WAITLIST,
    };

    const tagId = tagMap[tag];
    if (!tagId) {
      return res.status(400).json({ ok: false, error: 'Invalid tag. Must be: contractor, diy, or waitlist' });
    }

    // Step 1: Get access token
    const token = await getAccessToken();

    // Step 2: Find existing contact by email
    let contact = await findContactByEmail(token, email);

    // Step 3: Create contact if not found
    if (!contact) {
      const created = await createContact(token, email);
      contact = created.data;
    }

    // Step 4: Add the tag
    await addTagToContact(token, contact.id, tagId);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Kajabi API error:', error.message);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
