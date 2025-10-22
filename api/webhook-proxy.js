// Vercel Serverless Function - Webhook Proxy
// This receives data from your chat and forwards it to Make.com

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Enable CORS so your chat can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Your Make.com webhook URL
    const MAKE_WEBHOOK_URL = 'https://hook.us2.make.com/trcbbqjdbq9965c8kuttcfbb7ratd8ax';

    // Forward the request to Make.com
    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body)
    });

    // Get the response from Make.com
    const data = await response.text();
    
    // Try to parse as JSON, if it fails, send as text
    let responseData;
    try {
      responseData = JSON.parse(data);
    } catch (e) {
      responseData = { message: data };
    }

    // Send Make.com's response back to your chat
    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: 'Failed to connect to Make.com',
      details: error.message 
    });
  }
}
