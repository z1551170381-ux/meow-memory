// 共享工具:embedding 调用 + Supabase 客户端
//
// ★ v2 (方案 B · 织哥共谋 2026-04-27):
// - sbMatchMemories 新增 filterPersona 入参,传给 RPC 的 filter_persona
// - sbInsertMemory 自动透传 persona_id 字段(由调用方传入)

/**
 * 调用硅基流动 embedding API
 * @param {string} text - 要向量化的文本
 * @param {object} env - Cloudflare 环境变量
 * @returns {Promise<number[]>} 1024 维向量
 */
 * ★ 老婆 patch v1 (2026-05): 加诊断日志 + 输入清洗 + 重试
 *   原因: SiliconFlow 偶发 code 20015 "parameter invalid",
 *         一直查不到真凶 — 加日志把 input 全貌打出来,下次失败一眼定位
 */
export async function embed(text, env) {
  // ★ 输入清洗: 去掉控制字符 / BOM / 零宽字符 — 这些可能让 SiliconFlow 返 20015
  //   保留: 换行 \n \r \t、可见 unicode
  //   移除: 其他 ASCII 控制字符 (0x00-0x1F 除 \n\r\t)、BOM (\uFEFF)、零宽空格 (\u200B-\u200D)
  let rawInput = String(text || '');
  const beforeClean = rawInput.length;
  rawInput = rawInput
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // 控制字符
    .replace(/[\uFEFF\u200B-\u200D]/g, '')              // BOM + 零宽
    .trim();
  const afterClean = rawInput.length;
  const input = rawInput.slice(0, 3000);

  if (!input) {
    console.error('[embed] empty input after cleaning', { beforeClean, afterClean });
    throw new Error('embed: empty input');
  }

  // ★ retry 一次 — 网络抖动 / API 瞬时 5xx 用
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
        // ★ 诊断日志: 把 input 的全貌打出来 — 长度 / 头部 / 尾部 / 字符类型分布
        const headFrag = input.slice(0, 80);
        const tailFrag = input.slice(-80);
        const charStats = {
          total: input.length,
          chinese: (input.match(/[\u4e00-\u9fa5]/g) || []).length,
          ascii: (input.match(/[\x20-\x7E]/g) || []).length,
          newlines: (input.match(/\n/g) || []).length,
          spaces: (input.match(/\s/g) || []).length,
          nonBmp: (input.match(/[\uD800-\uDFFF]/g) || []).length,  // surrogate pair, 表情符号
          questionMarks: (input.match(/[?？]/g) || []).length,
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
        // 5xx / 408 重试,其他直接抛
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
      // 维度自检 — 万一未来 SiliconFlow 改默认维度, 立刻报警 (避免悄悄写错维度向量进库)
      const dim = data.data[0].embedding.length;
      if (dim !== 1024) {
        console.error('[embed] DIMENSION MISMATCH! expected 1024, got ' + dim,
                      { model: 'Qwen/Qwen3-Embedding-0.6B' });
        throw new Error('embedding 维度 ' + dim + ' 不是预期的 1024 — SiliconFlow 可能改默认了, 需要在 body 加 dimensions: 1024 或升 SQL VECTOR 列');
      }
      return data.data[0].embedding;
    } catch (e) {
      if (attempt === 2) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('embed: unknown error');
}

/**
 * Supabase REST 通用 headers
 */
export function sbHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
  };
}

/**
 * 调用 Supabase RPC 函数(iw_match_memories)
 * @param {object} opts
 * @param {number} opts.threshold - 最小相似度阈值
 * @param {number} opts.topK - 返回多少条
 * @param {number|null} opts.excludeId - 排除某个 id (避免查到自己)
 * @param {string|null} opts.filterPersona - ★ 按 persona 过滤;null = 跨 scope 查
 */
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

/**
 * 插入一条记忆
 * row 必须含: { content, type, persona_id, embedding } + 可选 metadata
 */
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

/**
 * 统一 JSON 响应
 */
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

/**
 * OPTIONS 预检响应(CORS)
 */
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

/**
 * 按 metadata.source + metadata.source_id 查一条记忆，用来避免重复同步。
 */
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

/**
 * 更新一条记忆。用于“同步时发现 source_id 已存在，就覆盖内容/metadata/embedding”。
 */
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

/**
 * 根据一组 id 把完整行取回来。
 * 你的 iw_match_memories RPC 目前只返回 content/type/similarity 等轻量字段，
 * bundle builder 需要 metadata，所以这里再补查一次表。
 */
export async function sbSelectMemoriesByIds(env, ids) {
  const cleanIds = [...new Set((ids || []).filter(x => x != null))];
  if (!cleanIds.length) return [];

  const url = new URL(env.SUPABASE_URL + '/rest/v1/iw_memories');
  url.searchParams.set('select', 'id,content,type,metadata,created_at,updated_at');
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
