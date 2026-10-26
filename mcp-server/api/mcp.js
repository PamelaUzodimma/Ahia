// Ahia MCP server: a small, stateless MCP endpoint (Streamable HTTP, JSON responses)
// that lets a Chord teammate call the Google Apps Script backend as two tools.
//
// Environment variables (set in Vercel, never commit them):
//   MCP_TOKEN         secret Chord sends as "Authorization: Bearer <token>"
//   APPS_SCRIPT_URL   the Apps Script web app /exec URL (without ?key=)
//   APPS_SCRIPT_KEY   the API_KEY set in Apps Script Script Properties

const BACKEND_TIMEOUT_MS = 8000;

const TOOLS = [
  {
    name: 'record_sale',
    description:
      'Records a completed sale in the shop ledger. Call only when EVERY item has a product name, a whole-number quantity, a unit price in naira and a payment method. The backend calculates all totals. Returns ok:true with a transaction_id only if the sale was really saved.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          description: 'One entry per product sold. Each entry has its own payment method.',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              product: { type: 'string', description: 'Product name exactly as the staff described it' },
              quantity: { type: 'integer', minimum: 1, description: 'Number of units sold' },
              unit_price: { type: 'number', minimum: 0, description: 'Price of ONE unit in naira' },
              payment_method: { type: 'string', enum: ['cash', 'transfer', 'pos'] }
            },
            required: ['product', 'quantity', 'unit_price', 'payment_method']
          }
        },
        allow_duplicate: {
          type: 'boolean',
          description:
            'Set true ONLY after the user confirmed an identical sale really happened a second time. Leave out otherwise.'
        }
      },
      required: ['lines']
    }
  },
  {
    name: 'get_daily_sales',
    description:
      'Returns recorded sales for one day: transaction count, total sales, split by cash/transfer/pos, and top products. Use for any question about how much was sold.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Day to report as YYYY-MM-DD. Leave out for today.'
        }
      }
    }
  }
];

async function callBackend(action, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    const url = `${process.env.APPS_SCRIPT_URL}?key=${encodeURIComponent(process.env.APPS_SCRIPT_KEY || '')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, action }),
      redirect: 'follow',
      signal: controller.signal
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return {
        ok: false,
        error_code: 'BAD_BACKEND_RESPONSE',
        message: 'The sales system gave an unreadable reply. Nothing is confirmed as saved.'
      };
    }
  } catch (err) {
    return {
      ok: false,
      error_code: err && err.name === 'AbortError' ? 'BACKEND_TIMEOUT' : 'BACKEND_UNREACHABLE',
      message: 'Could not reach the sales system in time. Nothing is confirmed as saved.'
    };
  } finally {
    clearTimeout(timer);
  }
}

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => {
    if (obj && obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

async function runTool(name, args) {
  let result;
  if (name === 'record_sale') {
    result = await callBackend('record_sale', pick(args, ['lines', 'allow_duplicate']));
  } else if (name === 'get_daily_sales') {
    result = await callBackend('get_daily_sales', pick(args, ['date']));
  } else {
    return null;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.ok !== true
  };
}

async function handle(msg) {
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: hasId ? msg.id : null, error: { code, message } });

  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(-32600, 'Invalid request');
  }
  if (!hasId) return null; // notifications (e.g. notifications/initialized) need no reply

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'ahia-mcp', version: '1.0.0' }
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const params = msg.params || {};
      const result = await runTool(params.name, params.arguments || {});
      if (!result) return fail(-32602, 'Unknown tool: ' + params.name);
      return reply(result);
    }
    default:
      return fail(-32601, 'Method not found: ' + msg.method);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Use POST' }));
  }

  const expected = process.env.MCP_TOKEN;
  if (!expected || (req.headers.authorization || '') !== 'Bearer ' + expected) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handle))).filter(Boolean);
    if (replies.length === 0) {
      res.statusCode = 202;
      return res.end();
    }
    return res.end(JSON.stringify(replies));
  }

  const reply = await handle(body);
  if (!reply) {
    res.statusCode = 202;
    return res.end();
  }
  return res.end(JSON.stringify(reply));
};
