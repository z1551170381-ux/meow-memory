// 共享工具:embedding 调用 + Supabase 客户端

/**
 * 调用硅基流动 embedding API
 * @param {string} text - 要向量化的文本
 * @param {object} env - Cloudflare 环境变量
 * @returns {Promise<number[]>} 1024 维向量
 */
export async function embed(text, env) {
  const input = String(text || '').trim().slice(0, 3000);
  if (!input) throw new Error('embed: empty input');

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
    throw new Error('embedding API ' + r.status + ': ' + errText.slice(0, 300));
  }

  const data = await r.json();
  if (!data.data || !data.data[0]?.embedding) {
    throw new Error('embedding API 返回格式异常: ' + JSON.stringify(data).slice(0, 300));
  }
  return data.data[0].embedding;
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
 */
export async function sbMatchMemories(env, queryEmbedding, opts = {}) {
  const body = {
    query_embedding: queryEmbedding,
    match_threshold: opts.threshold ?? 0.5,
    match_count: opts.topK ?? 3,
    exclude_id: opts.excludeId ?? null,
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
