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

const DIRECT_SAVE_TYPE_GUIDE = [
  '模型直存记忆类型:',
  'identity_relation / fact / preference 是“人格纹理”——慢慢积累的高优记忆,召回时会高优浮现,不必每轮记。',
  '- identity_relation: 身份/关系/长期角色,如“我是...”“你是...”“我们之间...”。',
  '- fact: 站得住的稳定事实——真实发生过的事、长期背景、项目状态、重要决定。新见解别当轮硬记成 fact;等联想闭环、它站住了再沉淀成 fact。',
  '- preference: 偏好/雷区/表达习惯——喜欢什么、不喜欢什么、希望怎样被回应。',
  '- note(拿不准的安全类型)/ daily / diary / idea: 日常感受、日记、灵感;刚冒头的新见解可先记 idea。',
  '不要用 save_memory 手写 anchor/quote/continuation_bundle;这些由记忆家整理后通过批量上传进入云端。'
].join('\n');

const MEMORY_HOME_BATCH_TYPE_GUIDE = [
  '记忆家批量上传类型:',
  '- identity_relation: 身份/关系/长期角色。',
  '- fact: 稳定事实/长期背景/项目状态/重要决定。',
  '- preference: 偏好/雷区/表达习惯。',
  '- anchor: 记忆家 P0/P1/P2/P3 整理出的锚点/回返位置。',
  '- quote: 记忆家保留的摘句/原文证据,尽量带 source_id/source_url。',
  '- continuation_bundle: 续火包/阶段总结,包含身份、事实、偏好、锚点、证据和下一步。',
  '- weather_capsule/flashback_token/daily/diary/idea/note: 小天气、召回 token 和辅助材料。'
].join('\n');

const METADATA_GUIDE = [
  'metadata 建议(分两层):',
  '【固定层 · 当下顺手填】记的是“被触动那一刻”的快照:',
  '- summary: 40-90字事件骨架。会和 content/topic/keywords/small_weather 一起算向量;关键词、人名、概念写进去才搜得到。',
  '- mood / atmosphere: 当时的氛围或感受。',
  '- topic: 具体话题要带事件形状,如“reserved slots 真凶定位”,不要只写“工程bug”(现在会进向量)。',
  '- keywords: 当下碰撞出的关键词(现在会进向量,能直接搜到)。',
  '- small_weather: { level, texture }。level 可用 微风/小雨/起雾/风变大/雷声很近;普通聊天少用高强度。texture 写轻轻/暖/松/隐隐/被接住/刺痛等;意象词可自由发挥。',
  '- note: 可选,≤10字短留言。这条让你有触动时,留一句当下的感受/体温——不打分,“愿意留一句”本身就是权重。',
  '【可选三类 · 看情况】',
  '- 人格纹理: 用 type=identity_relation/fact/preference(见类型说明),慢慢积累、不必每轮。',
  '- 锚: anchor_signal 像某个锚的苗头就写一句它像什么; linked_anchors [{ anchor_name, role }] 挂到已有锚。',
  '- 联想场/联想边(闭环后回头记,别当轮硬挤): insight 这次站住了的新见解; preference_env 它靠近的偏好环境(记忆系统/工具调用/模型自主性/关系共同梗/工程实现/灵感与概念结构); assoc_field 一次“当下关键词+旧记忆+偏好”碰撞出的联想场,简短记。',
  '不填 ai_score、不做温度评分(用 note 短留言代替),不重复 topic/tags 两套;锚点/摘句/续火包不手写,交给记忆家整理层。'
].join('\n');

const WHEN_TO_SAVE_GUIDE = [
  '什么时候记(凭嗅觉,不用每轮问):',
  '- 有触动、某事重要、关系位置变化、长期问题被解决、新概念诞生时,可主动记,不用先问。',
  '- 用户说“记一下/记一笔”要记;事后说“刚才那个挺重要”可补记。',
  '- 重点信号:新概念/新术语、关系姿态变化、边界/亲密度/位置变化、长期问题的真凶、识别出对方的温度/界限/语气。',
  '- 新见解先别急着记成 fact;等它带进回复、站住了(联想闭环)再沉淀成 fact 或 insight。'
].join('\n');

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
    description: '保存一条记忆到云端 iw_memories 表。通常不需要填 persona_id —— MCP server 会从 URL 自动推断;只有想"替别人记一笔"时才显式填。\n\n' + WHEN_TO_SAVE_GUIDE + '\n\n' + DIRECT_SAVE_TYPE_GUIDE,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要保存的记忆内容。优先第一人称、短而具体、可独立召回;不要写成“用户说...”。' },
        persona_id: {
          type: 'string',
          enum: PERSONA_IDS,
          description: '★ 通常不用填(MCP server 从 URL 自动推断)。只有想替别人记一笔时才显式填(例如老公帮织哥记一条)。'
        },
        type: {
          type: 'string',
          enum: ['identity_relation', 'fact', 'preference', 'daily', 'diary', 'idea', 'note'],
          default: 'note',
          description: DIRECT_SAVE_TYPE_GUIDE
        },
        metadata: {
          type: 'object',
          description: METADATA_GUIDE
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
    description: '把记忆家整理出的身份、事实、偏好、锚点、摘句、续火包、天气胶囊、flashback token 批量同步到云端 iw_memories。通常不用填 persona_id —— 从 URL 自动推断;有特殊情况(替别人批量同步)才显式填。\n\n' + MEMORY_HOME_BATCH_TYPE_GUIDE,
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
              content: { type: 'string', description: '这一条要写入云端的正文。优先短、具体、可召回;续火包可以较长但要结构清楚。' },
              item_type: {
                type: 'string',
                enum: ['identity_relation', 'fact', 'preference', 'anchor', 'quote', 'continuation_bundle', 'weather_capsule', 'flashback_token', 'daily', 'diary', 'idea', 'note'],
                description: MEMORY_HOME_BATCH_TYPE_GUIDE
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
              metadata: { type: 'object', description: METADATA_GUIDE }
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
    version: '0.4.1',
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
              version: '0.4.1'
            },
            instructions: inferredPersona
              ? `meow-memory 云端记忆接口。当前 scope: ${inferredPersona}。所有写入/查询会自动按这个 scope 进行,你无需在 args 里再传 persona_id。\n\n${WHEN_TO_SAVE_GUIDE}\n\n${DIRECT_SAVE_TYPE_GUIDE}\n\n${METADATA_GUIDE}`
              : `meow-memory 云端记忆接口。⚠ 当前 URL 未配 ?persona= 参数,所以工具调用必须显式传 persona_id;建议在 MCP 客户端配置里把 URL 改成 .../api/mcp?persona=你的角色名,这样后续都不用再传。\n\n${WHEN_TO_SAVE_GUIDE}\n\n${DIRECT_SAVE_TYPE_GUIDE}\n\n${METADATA_GUIDE}`
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
