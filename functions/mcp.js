// functions/mcp.js
// meow-memory MCP 翻译层
// 保留旧 save_memory / recall_memory，同时新增记忆家批量同步 + bundle 召回

const TOOLS = [
  {
    name: 'save_memory',
    description: '保存一条普通记忆到云端。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要保存的记忆内容' },
        type: {
          type: 'string',
          enum: ['daily', 'diary', 'idea', 'anchor', 'note', 'identity_relation'],
          default: 'daily',
          description: '记忆类型'
        },
        metadata: {
          type: 'object',
          description: '可选 metadata'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'recall_memory',
    description: '按语义搜索相关旧记忆，返回散句列表。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的主题、感受或关键词' },
        topK: { type: 'integer', default: 5, description: '返回最多几条' },
        minSimilarity: { type: 'number', default: 0.5, description: '最低相似度' }
      },
      required: ['query']
    }
  },
  {
    name: 'meow_memory_upsert_batch',
    description: '把记忆家整理出的摘句、锚点、天气胶囊、flashback token 批量同步到云端 iw_memories。',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', default: 'default' },
        persona_id: { type: 'string' },
        persona_name: { type: 'string' },
        scope_id: { type: 'string' },
        dedupe: { type: 'boolean', default: true },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              item_type: {
                type: 'string',
                enum: ['identity_relation', 'anchor', 'weather_capsule', 'flashback_token', 'quote', 'note']
              },
              source: { type: 'string' },
              source_id: { type: 'string' },
              source_url: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              weight: { type: 'number' },
              metadata: { type: 'object' }
            },
            required: ['content']
          }
        }
      },
      required: ['items']
    }
  },
  {
    name: 'meow_memory_query_bundle',
    description: '按语义召回记忆，并压成给聊天入口可直接使用的短 JSON memory bundle。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'integer', default: 20 },
        minSimilarity: { type: 'number', default: 0.3 },
        persona_id: { type: 'string' },
        persona_name: { type: 'string' },
        debug: { type: 'boolean', default: false }
      },
      required: ['query']
    }
  }
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id'
};

function json(body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

async function callApi(origin, path, body) {
  const resp = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(data.error || `${path} ${resp.status}: ${text.slice(0, 300)}`);
  }

  return data;
}

function mcpTextResult(id, data) {
  return json({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }]
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet() {
  return json({
    name: 'meow-memory MCP server',
    status: 'ok',
    hint: 'POST this URL with JSON-RPC 2.0 messages',
    tools: TOOLS.map(t => t.name)
  });
}

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    });
  }

  const { method, params = {}, id } = body;
  const origin = new URL(request.url).origin;

  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    switch (method) {
      case 'initialize':
        return json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'meow-memory',
              version: '0.2.0'
            },
            instructions: 'meow-memory 云端记忆接口：可保存、召回，也可同步记忆家结构化记忆并返回 memory bundle。'
          }
        });

      case 'ping':
        return json({ jsonrpc: '2.0', id, result: {} });

      case 'tools/list':
        return json({
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS }
        });

      case 'tools/call': {
        const { name, arguments: args = {} } = params;

        if (name === 'save_memory') {
          const data = await callApi(origin, '/api/memory', {
            content: args.content,
            type: args.type || 'daily',
            metadata: args.metadata || {}
          });
          return mcpTextResult(id, data);
        }

        if (name === 'recall_memory') {
          const data = await callApi(origin, '/api/recall', {
            query: args.query,
            topK: args.topK || 5,
            minSimilarity: args.minSimilarity ?? 0.5
          });
          return mcpTextResult(id, data);
        }

        if (name === 'meow_memory_upsert_batch') {
          const data = await callApi(origin, '/api/memory-batch', {
            user_id: args.user_id || 'default',
            persona_id: args.persona_id || '',
            persona_name: args.persona_name || '',
            scope_id: args.scope_id || '',
            dedupe: args.dedupe !== false,
            items: args.items || []
          });
          return mcpTextResult(id, data);
        }

        if (name === 'meow_memory_query_bundle') {
          const data = await callApi(origin, '/api/recall-bundle', {
            query: args.query,
            topK: args.topK || 20,
            minSimilarity: args.minSimilarity ?? 0.3,
            persona_id: args.persona_id || '',
            persona_name: args.persona_name || '',
            debug: !!args.debug
          });
          return mcpTextResult(id, data);
        }

        return json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` }
        });
      }

      default:
        return json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        });
    }
  } catch (err) {
    return json({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err.message || 'Internal error' }
    });
  }
}
