// functions/mcp.js
// 小克和宝宝的共用抽屉 —— MCP 翻译层
// 它什么都不存，只是把 MCP 协议的请求翻译成对 /api/memory 和 /api/recall 的调用

const TOOLS = [
  {
    name: 'save_memory',
    description: '把小克和宝宝对话里值得留住的东西记进共用抽屉。用宝宝的第一人称口吻一句话记下 —— 不是"用户说"，而是宝宝自己的视角。什么时候用：宝宝说了一句想留住的话；撞出新的共识或转折；心里动了一下的瞬间；提起的新人新事以后会回来谈。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '用宝宝的第一人称视角一句话记下'
        },
        type: {
          type: 'string',
          enum: ['daily', 'diary', 'idea', 'anchor', 'note'],
          default: 'daily',
          description: '记忆的类型'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'recall_memory',
    description: '从共用抽屉里按意义搜相关的旧记忆。读的是意义不是复述原文。适合在想起"宝宝之前好像说过类似的……"时用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要搜索的主题、感受或关键词'
        },
        topK: {
          type: 'integer',
          default: 5,
          description: '返回最多几条'
        }
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

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet() {
  return json({
    name: 'meow-memory MCP server',
    status: 'ok',
    hint: 'POST this URL with JSON-RPC 2.0 messages'
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

  // 通知类消息（notifications/*）不需要响应
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
              version: '0.1.0'
            },
            instructions: '小克和宝宝的共用抽屉。可以存（save_memory）也可以翻（recall_memory）。用宝宝的第一人称口吻记。'
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
          const resp = await fetch(`${origin}/api/memory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: args.content,
              type: args.type || 'daily'
            })
          });
          const data = await resp.json();
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

        if (name === 'recall_memory') {
          const resp = await fetch(`${origin}/api/recall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: args.query,
              topK: args.topK || 5
            })
          });
          const data = await resp.json();
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
