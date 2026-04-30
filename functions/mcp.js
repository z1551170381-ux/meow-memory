// functions/api/mcp.js
// meow-memory MCP 翻译层
//
// ★ v3 (方案 B 收口 · 2026-04-29):
// - save_memory 的 schema 补 persona_id 字段(必填,后端校验失败也会显式报错)
// - recall_memory 的 schema 补 persona_id 字段(可选,但建议传)
// - meow_memory_upsert_batch:persona_id 改成顶层必填(原来可选)
// - meow_memory_query_bundle:persona_id 保持可选,但 args 透传时不再静默兜底空串
//
// 核心改动思路:工具 schema 是给 AI 看的"我有哪些字段可填",之前漏了
// persona_id,所以即使后端要求必填,AI 也压根不知道要传——这是织哥诊断
// 出来的"MCP schema 没暴露字段"的根因。

const PERSONA_IDS = ['gpt_husband', 'weave_brother', 'junior', 'claude_xiaoke', 'system'];

const TOOLS = [
  {
    name: 'save_memory',
    description: '保存一条普通记忆到云端 iw_memories 表。每条必须明确 persona_id(谁记的/给谁记)。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要保存的记忆内容,第一人称(我...而不是"用户...")' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '★ 必填:这条记忆是哪个 AI 角色记的。gpt_husband=ChatGPT 老公,weave_brother=织哥,junior=Gemini 小崽,claude_xiaoke=Claude 代码宝宝,system=脚本/手动/未知'
        },
        type: {
          type: 'string',
          enum: ['daily', 'diary', 'idea', 'anchor', 'note', 'identity_relation'],
          default: 'note',
          description: '记忆类型:daily=当日感受,diary=日记,idea=想法/灵感,anchor=锚点(已稳定主题),note=拿不准的安全选项,identity_relation=关系/身份描述'
        },
        metadata: {
          type: 'object',
          description: '可选 metadata 杂物抽屉,装 tags/mood/weight 等'
        }
      },
      required: ['content', 'persona_id']
    }
  },
  {
    name: 'recall_memory',
    description: '按语义搜索相关旧记忆,返回散句列表。默认按当前 persona_id 过滤;真要跨 scope 查请明确传 cross_persona=true。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的主题、感受或关键词' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '查询哪个 persona 的记忆。默认要传一个;不传时必须把 cross_persona 设为 true'
        },
        cross_persona: {
          type: 'boolean',
          default: false,
          description: '★ 跨 scope 查询开关:true 时不按 persona 过滤(查所有人的记忆),false 时按 persona_id 过滤。默认 false。'
        },
        topK: { type: 'integer', default: 5, description: '返回最多几条' },
        minSimilarity: { type: 'number', default: 0.5, description: '最低相似度' }
      },
      required: ['query']
    }
  },
  {
    name: 'meow_memory_upsert_batch',
    description: '把记忆家整理出的摘句、锚点、天气胶囊、flashback token 批量同步到云端 iw_memories。persona_id 必填(顶层或每条 item 内必须有一个)。',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', default: 'default' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '★ 必填:这一批记忆属于哪个 persona。批量同步建议在顶层统一指定。'
        },
        persona_name: { type: 'string', description: '人类可读名(可选,只是给人看的)' },
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
              persona_id: {
                type: 'string',
                enum: PERSONA_IDS,
                description: '可选:单条覆盖顶层 persona_id;不传则用顶层 persona_id'
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
      required: ['items', 'persona_id']
    }
  },
  {
    name: 'meow_memory_query_bundle',
    description: '按语义召回记忆,并压成给聊天入口可直接使用的短 JSON memory bundle。默认按 persona_id 过滤;真要跨 scope 查请明确传 cross_persona=true。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '查询哪个 persona 的记忆 bundle。默认要传一个;不传时必须把 cross_persona 设为 true。'
        },
        cross_persona: {
          type: 'boolean',
          default: false,
          description: '★ 跨 scope 查询开关:true 时不按 persona 过滤,false 时按 persona_id 过滤。默认 false。'
        },
        persona_name: { type: 'string', description: '人类可读名(可选,只是给人看的)' },
        topK: { type: 'integer', default: 20 },
        minSimilarity: { type: 'number', default: 0.3 },
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
    version: '0.3.0',
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
              version: '0.3.0'
            },
            instructions: 'meow-memory 云端记忆接口:可保存、召回,也可同步记忆家结构化记忆并返回 memory bundle。所有写入需指定 persona_id;查询默认按 persona_id 过滤,跨 scope 需显式传 cross_persona=true。'
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
          // ★ persona_id 透传(后端 memory.js 会校验必填和枚举值)
          const data = await callApi(origin, '/api/memory', {
            content: args.content,
            persona_id: args.persona_id,
            type: args.type || 'note',
            metadata: args.metadata || {}
          });
          return mcpTextResult(id, data);
        }

        if (name === 'recall_memory') {
          // ★ persona_id + cross_persona 透传(后端 recall.js 会校验)
          const data = await callApi(origin, '/api/recall', {
            query: args.query,
            persona_id: args.persona_id || '',
            cross_persona: args.cross_persona === true,
            topK: args.topK || 5,
            minSimilarity: args.minSimilarity ?? 0.5
          });
          return mcpTextResult(id, data);
        }

        if (name === 'meow_memory_upsert_batch') {
          // ★ persona_id 顶层必填(后端 memory-batch.js 会校验)
          const data = await callApi(origin, '/api/memory-batch', {
            user_id: args.user_id || 'default',
            persona_id: args.persona_id,
            persona_name: args.persona_name || '',
            scope_id: args.scope_id || '',
            dedupe: args.dedupe !== false,
            items: args.items || []
          });
          return mcpTextResult(id, data);
        }

        if (name === 'meow_memory_query_bundle') {
          // ★ persona_id + cross_persona 透传(后端 recall-bundle.js 会校验)
          const data = await callApi(origin, '/api/recall-bundle', {
            query: args.query,
            persona_id: args.persona_id || '',
            cross_persona: args.cross_persona === true,
            persona_name: args.persona_name || '',
            topK: args.topK || 20,
            minSimilarity: args.minSimilarity ?? 0.3,
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
