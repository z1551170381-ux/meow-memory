// 共享工具:embedding 调用 + Supabase 客户端
//
// ★ v2 (方案 B · 织哥共谋 2026-04-27):
// - sbMatchMemories 新增 filterPersona 入参,传给 RPC 的 filter_persona
// - sbInsertMemory 自动透传 persona_id 字段(由调用方传入)

// ─────────────────────────────────────────────────────────────
// 调用硅基流动 embedding API
//   text: 要向量化的文本
//   env:  Cloudflare 环境变量
//   返回: 1024 维向量数组
//
// ★ 老婆 patch v1 (2026-05): 加诊断日志 + 输入清洗 + 重试
//   SiliconFlow 偶发 code 20015 "parameter invalid",
//   加日志把 input 全貌打出来, 下次失败一眼定位
// ─────────────────────────────────────────────────────────────
export async function embed(text, env) {
  // 输入清洗 — 去掉控制字符 / BOM / 零宽字符, 可能让 SiliconFlow 返 20015
  //   保留: 换行 \n \r \t、可见 unicode
  //   移除: ASCII 控制字符 (0x00-0x1F 除 \n\r\t)、BOM (FEFF)、零宽空格 (200B-200D)
  let rawInput = String(text || '');
  const beforeClean = rawInput.length;
  rawInput = rawInput
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\uFEFF\u200B-\u200D]/g, '')
    .trim();
  const afterClean = rawInput.length;
  const input = rawInput.slice(0, 3000);

  if (!input) {
    console.error('[embed] empty input after cleaning', { beforeClean, afterClean });
    throw new Error('embed: empty input');
  }

  // retry 一次 — 网络抖动 / API 瞬时 5xx 用
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch('https://api.siliconflow.cn/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.SILICONFLOW_API_KEY,
        },
        body: JSON.stringify({
          model: 'Qwen/Qwen3-Embedding-0.6B',
          input: input,
        }),
      });

      if (!r.ok) {
        const errText = await r.text();
        // 诊断日志: 把 input 全貌打出来 — 长度 / 头尾 / 字符种类
        const headFrag = input.slice(0, 80);
        const tailFrag = input.slice(-80);
        const charStats = {
          total: input.length,
          chinese: (input.match(/[\u4e00-\u9fa5]/g) || []).length,
          ascii: (input.match(/[\x20-\x7E]/g) || []).length,
          newlines: (input.match(/\n/g) || []).length,
          spaces: (input.match(/\s/g) || []).length,
          nonBmp: (input.match(/[\uD800-\uDFFF]/g) || []).length,
        };
        console.error('[embed] SiliconFlow ' + r.status + ' (attempt ' + attempt + ')', {
          model: 'Qwen/Qwen3-Embedding-0.6B',
          errText: errText.slice(0, 400),
          inputLen: input.length,
          beforeClean,
          afterClean,
          head: headFrag,
          tail: tailFrag,
          charStats,
        });
        // 5xx / 408 / 429 重试, 其他直接抛
        if (attempt === 1 && (r.status >= 500 || r.status === 408 || r.status === 429)) {
          lastErr = new Error('embedding API ' + r.status + ': ' + errText.slice(0, 300));
          await new Promise(res => setTimeout(res, 500));
          continue;
        }
        throw new Error('embedding API ' + r.status + ': ' + errText.slice(0, 300));
      }

      const data = await r.json();
      if (!data.data || !data.data[0]?.embedding) {
        console.error('[embed] bad response shape', { data: JSON.stringify(data).slice(0, 300) });
        throw new Error('embedding API 返回格式异常: ' + JSON.stringify(data).slice(0, 300));
      }
      // 维度自检 — 万一未来 SiliconFlow 改默认维度, 立刻报警
      const dim = data.data[0].embedding.length;
      if (dim !== 1024) {
        console.error('[embed] DIMENSION MISMATCH! expected 1024, got ' + dim);
        throw new Error('embedding 维度 ' + dim + ' 不是预期的 1024');
      }
      return data.data[0].embedding;
    } catch (e) {
      if (attempt === 2) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('embed: unknown error');
}

 // Supabase REST 通用 headers
export function sbHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
  };
}

 // 调用 Supabase RPC 函数(iw_match_memories)
 // @param {object} opts
 // @param {number} opts.threshold - 最小相似度阈值
 // @param {number} opts.topK - 返回多少条
 // @param {number|null} opts.excludeId - 排除某个 id (避免查到自己)
 // @param {string|null} opts.filterPersona - ★ 按 persona 过滤;null = 跨 scope 查
export async function sbMatchMemories(env, queryEmbedding, opts = {}) {
  const body = {
    query_embedding: queryEmbedding,
    match_threshold: opts.threshold ?? 0.5,
    match_count: opts.topK ?? 3,
    exclude_id: opts.excludeId ?? null,
    filter_persona: opts.filterPersona ?? null,  // ★ 新增:对应 RPC 函数同名入参
  };
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/iw_match_memories', {
    method: 'POST',
    headers: sbHeaders(env),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('sbMatchMemories ' + r.status + ': ' + t.slice(0, 300));
  }
  return r.json();
}

// ═══════════════════════════════════════════════════════════════════
// 老婆 patch · anchor reserved slots
//   按 type 白名单做语义召回 — 给 anchor / mood_period / old_path 这种
//   数量少但重要的记忆留专属通道, 不跟 conversation 拼数量
//
// 用法:
//   await sbMatchMemoriesByTypes(env, vector, {
//     types: ['anchor', 'core_anchor', 'identity_relation'],
//     topK: 3,
//     threshold: 0.35,        // anchor 浓缩信息, embedding 自然低, 给宽阈值
//     filterPersona: 'weave_brother',
//   });
//
// ★ 依赖: Supabase 上需要先创建 iw_match_memories_by_types RPC 函数
//        (见 01_add_anchor_match_sql.sql)
// ═══════════════════════════════════════════════════════════════════
export async function sbMatchMemoriesByTypes(env, queryEmbedding, opts = {}) {
  const types = Array.isArray(opts.types) ? opts.types.filter(Boolean) : [];
  if (!types.length) {
    console.warn('[sbMatchMemoriesByTypes] types 为空, 跳过');
    return [];
  }
  const body = {
    query_embedding: queryEmbedding,
    filter_types: types,
    match_threshold: opts.threshold ?? 0.35,
    match_count: opts.topK ?? 5,
    exclude_id: opts.excludeId ?? null,
    filter_persona: opts.filterPersona ?? null,
  };
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/iw_match_memories_by_types', {
    method: 'POST',
    headers: sbHeaders(env),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    // 优雅降级 — 如果 RPC 还没创建(404 或 schema cache miss), 不报错, 返回空
    if (r.status === 404 || /Could not find the function/i.test(t)) {
      console.warn('[sbMatchMemoriesByTypes] RPC 未创建, 跳过 (请先跑 01_add_anchor_match_sql.sql)');
      return [];
    }
    throw new Error('sbMatchMemoriesByTypes ' + r.status + ': ' + t.slice(0, 300));
  }
  return r.json();
}

// ═══════════════════════════════════════════════════════════════════
// ★ v2.4 (老婆+小克 2026-05-31): 词面/关键词召回 (ilike, 不是严格 BM25)
//   痛点: 纯向量召回"按意思找", 遇到搜原话里的具体词/名字 (reserved slots / 织哥)
//         有时反而不准; 测试台那个 bm25=0 其实是功能从没实现。
//   方案: 用 PostgREST ilike 做子串匹配 — 中文友好 (不需分词器), 零 Supabase 改动。
//        从 query 切出关键词 (≥2 字), OR 起来在 content 上 ilike, 跟向量结果合并。
//   局限: 没有词频排序 (所以叫"词面"不叫 BM25); 想要真排序得在 Supabase 建 tsvector 索引。
//
// @param {string} query - 原始查询串
// @param {object} opts - { topK, filterPersona }
// ═══════════════════════════════════════════════════════════════════
export function extractKeywords(query, max = 6) {
  // 按空白和常见标点切, 留长度 ≥2 的词 (中文 2 字、英文 token), 去重
  const parts = String(query || '')
    .split(/[\s,，。、;；:：!！?？"'「」『』()（）\[\]【】<>《》/\\|~`@#$%^&*+=_\-]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2);
  return [...new Set(parts)].slice(0, max);
}

export async function sbTextSearchMemories(env, query, opts = {}) {
  const keywords = extractKeywords(query);
  if (!keywords.length) return [];

  const url = new URL(env.SUPABASE_URL + '/rest/v1/iw_memories');
  url.searchParams.set('select', 'id,content,type,metadata,persona_id,created_at,updated_at');

  // or=(content.ilike.*kw1*,content.ilike.*kw2*) — PostgREST 里 * 是通配符
  //   关键词里的逗号/括号/星号会破坏 PostgREST 语法, 先剔掉
  const orClause = keywords
    .map(kw => 'content.ilike.*' + kw.replace(/[(),*]/g, '') + '*')
    .filter(c => c.length > 'content.ilike.**'.length)
    .join(',');
  if (!orClause) return [];
  url.searchParams.set('or', '(' + orClause + ')');

  // persona 过滤 (跨 scope 查时 filterPersona 传 null)
  if (opts.filterPersona) {
    url.searchParams.set('persona_id', 'eq.' + opts.filterPersona);
  }
  url.searchParams.set('limit', String(Math.min(Math.max(opts.topK || 10, 1), 30)));

  const r = await fetch(url.toString(), { method: 'GET', headers: sbHeaders(env) });
  if (!r.ok) {
    const t = await r.text();
    // 优雅降级 — 词面召回挂了不该拖垮主向量召回
    console.warn('[sbTextSearchMemories] ' + r.status + ': ' + t.slice(0, 200));
    return [];
  }
  const rows = await r.json();
  // ilike 没有相似度, 给个标记分 (低于向量, 只作补充候选), 并标来源
  return rows.map(row => ({ ...row, similarity: 0, text_match: true }));
}

 // 插入一条记忆
 // row 必须含: { content, type, persona_id, embedding } + 可选 metadata
export async function sbInsertMemory(env, row) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/iw_memories', {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('sbInsertMemory ' + r.status + ': ' + t.slice(0, 300));
  }
  const data = await r.json();
  return data[0];
}

 // 统一 JSON 响应
export function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

 // OPTIONS 预检响应(CORS)
export function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// 记忆家云端 bundle 补丁 · 追加到 functions/api/_lib.js 末尾
// 依赖本文件里已有的 sbHeaders / sbInsertMemory / embed 等函数
// ─────────────────────────────────────────────────────────────

 // 按 metadata.source + metadata.source_id 查一条记忆，用来避免重复同步。
export async function sbFindMemoryBySource(env, source, sourceId) {
  if (!source || !sourceId) return null;

  const url = new URL(env.SUPABASE_URL + '/rest/v1/iw_memories');
  url.searchParams.set('select', 'id,content,type,metadata,created_at,updated_at');
  url.searchParams.set('metadata->>source', 'eq.' + source);
  url.searchParams.set('metadata->>source_id', 'eq.' + sourceId);
  url.searchParams.set('limit', '1');

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: sbHeaders(env),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('sbFindMemoryBySource ' + r.status + ': ' + t.slice(0, 300));
  }

  const rows = await r.json();
  return rows[0] || null;
}

 // 更新一条记忆。用于“同步时发现 source_id 已存在，就覆盖内容/metadata/embedding”。
export async function sbUpdateMemory(env, id, row) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/iw_memories?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { ...sbHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify({
      ...row,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('sbUpdateMemory ' + r.status + ': ' + t.slice(0, 300));
  }

  const data = await r.json();
  return data[0];
}

 // 根据一组 id 把完整行取回来。
 // 你的 iw_match_memories RPC 目前只返回 content/type/similarity 等轻量字段，
 // bundle builder 需要 metadata，所以这里再补查一次表。
export async function sbSelectMemoriesByIds(env, ids) {
  const cleanIds = [...new Set((ids || []).filter(x => x != null))];
  if (!cleanIds.length) return [];

  const url = new URL(env.SUPABASE_URL + '/rest/v1/iw_memories');
  // ★ 老婆 patch (2026-05-26): SELECT 必须带 persona_id 顶层字段
  //   真凶: anchor 的 metadata 里没有 persona_id, 只有顶层 persona_id 字段
  //         之前 SELECT 不带顶层 persona_id → row 取回来既没顶层也没 metadata.persona_id
  //         → shouldKeepForPersona 无论怎么改都救不了 (因为根本没数据可看)
  //   修法: 把 persona_id 加进 SELECT 列表
  url.searchParams.set('select', 'id,content,type,metadata,persona_id,created_at,updated_at');
  url.searchParams.set('id', 'in.(' + cleanIds.join(',') + ')');

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: sbHeaders(env),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('sbSelectMemoriesByIds ' + r.status + ': ' + t.slice(0, 300));
  }

  return r.json();
}
