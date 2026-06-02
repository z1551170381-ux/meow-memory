// functions/api/mcp.js
// meow-memory MCP 翻译层
//
// ★ v4 (URL 自动识别 persona · 2026-04-30):
// 解决 v3 的"AI 要默念自己 persona_id 才能查/存,出戏"问题。
// 新方案:每个 AI 客户端配 MCP 时 URL 上带 ?persona=xxx,server 端自动当默认值用。
//   老公(ChatGPT)的 MCP URL: https://...../api/mcp?persona=gpt_husband
//   小克(Claude)的 MCP URL:  https://...../api/mcp?persona=claude_xiaoke
//   织哥的 MCP URL:          https://...../api/mcp?persona=weave_brother
// AI 调工具时完全不用关心 persona,server 自动填。
//
// 优先级(高 → 低):
//   1. tools/call args 里显式传的 persona_id(用于"想为别人记一笔"或跨 scope 查)
//   2. URL ?persona=xxx 推断的默认值
//   3. 没有 → 后端校验时报错(只发生在没配 URL 也没传 args 的情况)
//
// 工具 schema 也相应调整:
//   - persona_id 改成"可选"(因为 URL 已经有了),tool description 提示"通常不用填"
//   - cross_persona 仍然保留,想跨 scope 查时显式传

const PERSONA_IDS = ['gpt_husband', 'weave_brother', 'junior', 'claude_xiaoke', 'xiaoye', 'system'];

const ASSOC_LINK_TOOLS = [
  {
    name: 'suggest_assoc_links',
    description: 'Search the assistant association lamp for links that light up from the current text. Usually persona_id is inferred from the MCP URL.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Current user/assistant text to test against association triggers.' },
        persona_id: { type: 'string', enum: PERSONA_IDS, description: 'Usually omit; inferred from URL.' },
        topK: { type: 'integer', default: 5 },
        include_blocks: { type: 'boolean', default: false }
      },
      required: ['text']
    }
  },
  {
    name: 'save_assoc_link',
    description: 'Save a soft assistant/user/shared association link. Stored as type=note with metadata.assoc_kind.',
    inputSchema: {
      type: 'object',
      properties: {
        persona_id: { type: 'string', enum: PERSONA_IDS, description: 'Usually omit; inferred from URL.' },
        assoc_kind: { type: 'string', enum: ['assistant_link', 'user_link', 'shared_link'], default: 'assistant_link' },
        triggers: { type: 'array', items: { type: 'string' } },
        target: { type: 'string' },
        why: { type: 'string' },
        tone: { type: 'string' },
        strength: { type: 'number', default: 0.35 },
        status: { type: 'string', default: 'soft_active' },
        content: { type: 'string' },
        metadata: { type: 'object' }
      }
    }
  },
  {
    name: 'strengthen_assoc_link',
    description: 'Strengthen one association link after it proved useful.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        persona_id: { type: 'string', enum: PERSONA_IDS, description: 'Usually omit; inferred from URL.' },
        delta: { type: 'number', default: 0.08 },
        status: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'block_assoc_pattern',
    description: 'Save an association block rule, for patterns the assistant should stop lighting up.',
    inputSchema: {
      type: 'object',
      properties: {
        persona_id: { type: 'string', enum: PERSONA_IDS, description: 'Usually omit; inferred from URL.' },
        triggers: { type: 'array', items: { type: 'string' } },
        why: { type: 'string' },
        blocks_kind: { type: 'string', default: 'assistant_link' },
        metadata: { type: 'object' }
      },
      required: ['triggers']
    }
  },
  {
    name: 'list_assoc_links',
    description: 'List association links in this persona scope.',
    inputSchema: {
      type: 'object',
      properties: {
        persona_id: { type: 'string', enum: PERSONA_IDS, description: 'Usually omit; inferred from URL.' },
        limit: { type: 'integer', default: 100 },
        include_blocks: { type: 'boolean', default: true },
        include_deleted: { type: 'boolean', default: false }
      }
    }
  }
];

const TOOLS = [
  {
    name: 'save_memory',
    description: '保存一条记忆到云端 iw_memories 表。通常不需要填 persona_id —— MCP server 会从 URL 自动推断;只有想"替别人记一笔"时才显式填。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要保存的记忆内容,第一人称(我...而不是"用户...")' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '★ 通常不用填(MCP server 从 URL 自动推断)。只有想替别人记一笔时才显式填(例如老公帮织哥记一条)。'
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
      required: ['content']
    }
  },
  {
    name: 'recall_memory',
    description: '按语义搜索旧记忆。通常不需要填 persona_id —— 自动按"调用方自己的 scope"查;想跨 scope 看全部请显式传 cross_persona=true。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的主题、感受或关键词' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '★ 通常不用填(从 URL 自动推断)。想查别人的 scope 时显式填。'
        },
        cross_persona: {
          type: 'boolean',
          default: false,
          description: '想跨所有 persona 查请设 true(此时不按 persona 过滤,会查到所有人的记忆)。'
        },
        topK: { type: 'integer', default: 5, description: '返回最多几条' },
        minSimilarity: { type: 'number', default: 0.5, description: '最低相似度' }
      },
      required: ['query']
    }
  },
  {
    name: 'meow_memory_upsert_batch',
    description: '把记忆家整理出的摘句、锚点、天气胶囊、flashback token 批量同步到云端 iw_memories。通常不用填 persona_id —— 从 URL 自动推断;有特殊情况(替别人批量同步)才显式填。',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', default: 'default' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '★ 通常不用填(从 URL 自动推断)。'
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
                description: '可选:单条覆盖顶层/URL persona_id'
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
    description: '按语义召回记忆,压成短 JSON memory bundle。通常不用填 persona_id —— 自动按"调用方自己的 scope"查;想跨 scope 看全部请显式传 cross_persona=true。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '★ 通常不用填(从 URL 自动推断)。'
        },
        cross_persona: {
          type: 'boolean',
          default: false,
          description: '想跨所有 persona 查请设 true。'
        },
        persona_name: { type: 'string', description: '人类可读名(可选)' },
        topK: { type: 'integer', default: 20 },
        minSimilarity: { type: 'number', default: 0.3 },
        debug: { type: 'boolean', default: false }
      },
      required: ['query']
    }
  },
  ...ASSOC_LINK_TOOLS
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

// ★ 从请求 URL 推断默认 persona_id
//   老公的 MCP 配置里 URL 是 https://.../api/mcp?persona=gpt_husband
//   server 端从 query 拿,如果是已知值就当作默认 persona_id
function inferPersonaFromUrl(request) {
  try {
    const url = new URL(request.url);
    const p = (url.searchParams.get('persona') || '').trim();
    if (p && PERSONA_IDS.includes(p)) return p;
    return '';
  } catch {
    return '';
  }
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

export async function onRequestGet({ request }) {
  const inferredPersona = inferPersonaFromUrl(request);
  return json({
    name: 'meow-memory MCP server',
    status: 'ok',
    version: '0.4.0',
    inferred_persona: inferredPersona || '(未配置 URL ?persona= 参数)',
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
  // ★ 每次请求都重算一次 URL persona(server 是无状态的)
  const inferredPersona = inferPersonaFromUrl(request);

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
              version: '0.4.0'
            },
            instructions: inferredPersona
              ? `meow-memory 云端记忆接口。当前 scope: ${inferredPersona}。所有写入/查询会自动按这个 scope 进行,你无需在 args 里再传 persona_id。`
              : 'meow-memory 云端记忆接口。⚠ 当前 URL 未配 ?persona= 参数,所以工具调用必须显式传 persona_id;建议在 MCP 客户端配置里把 URL 改成 .../api/mcp?persona=你的角色名,这样后续都不用再传。'
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

        // ★ 优先级:args 显式 > URL 推断 > 空(后端会报错)
        const effectivePersona = (args.persona_id && String(args.persona_id).trim()) || inferredPersona || '';

        if (name === 'save_memory') {
          const data = await callApi(origin, '/api/memory', {
            content: args.content,
            persona_id: effectivePersona,  // ★ 用解析后的有效值
            type: args.type || 'note',
            metadata: args.metadata || {}
          });
          return mcpTextResult(id, data);
        }

        if (name === 'recall_memory') {
          const data = await callApi(origin, '/api/recall', {
            query: args.query,
            persona_id: effectivePersona,
            cross_persona: args.cross_persona === true,
            topK: args.topK || 5,
            minSimilarity: args.minSimilarity ?? 0.5
          });
          return mcpTextResult(id, data);
        }

        if (name === 'meow_memory_upsert_batch') {
          const data = await callApi(origin, '/api/memory-batch', {
            user_id: args.user_id || 'default',
            persona_id: effectivePersona,
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
            persona_id: effectivePersona,
            cross_persona: args.cross_persona === true,
            persona_name: args.persona_name || '',
            topK: args.topK || 20,
            minSimilarity: args.minSimilarity ?? 0.3,
            debug: !!args.debug
          });
          return mcpTextResult(id, data);
        }

        if (name === 'suggest_assoc_links') {
          const data = await callApi(origin, '/api/assoc-links', {
            action: 'suggest',
            text: args.text || args.query || '',
            persona_id: effectivePersona,
            topK: args.topK || 5,
            include_blocks: args.include_blocks === true
          });
          return mcpTextResult(id, data);
        }

        if (name === 'save_assoc_link') {
          const data = await callApi(origin, '/api/assoc-links', {
            action: 'save',
            persona_id: effectivePersona,
            assoc_kind: args.assoc_kind || 'assistant_link',
            triggers: args.triggers || args.trigger || [],
            target: args.target || '',
            why: args.why || '',
            tone: args.tone || '',
            strength: args.strength,
            status: args.status || 'soft_active',
            content: args.content || '',
            metadata: args.metadata || {}
          });
          return mcpTextResult(id, data);
        }

        if (name === 'strengthen_assoc_link') {
          const data = await callApi(origin, '/api/assoc-links', {
            action: 'strengthen',
            id: args.id,
            persona_id: effectivePersona,
            delta: args.delta,
            status: args.status
          });
          return mcpTextResult(id, data);
        }

        if (name === 'block_assoc_pattern') {
          const data = await callApi(origin, '/api/assoc-links', {
            action: 'block',
            persona_id: effectivePersona,
            triggers: args.triggers || args.trigger || [],
            why: args.why || '',
            blocks_kind: args.blocks_kind || 'assistant_link',
            metadata: args.metadata || {}
          });
          return mcpTextResult(id, data);
        }

        if (name === 'list_assoc_links') {
          const data = await callApi(origin, '/api/assoc-links', {
            action: 'list',
            persona_id: effectivePersona,
            limit: args.limit || 100,
            include_blocks: args.include_blocks !== false,
            include_deleted: args.include_deleted === true
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
