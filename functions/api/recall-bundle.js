// functions/api/recall-bundle.js
// POST /api/recall-bundle
// body: { query, persona_id, cross_persona?, persona_name?, topK?, minSimilarity?, debug? }
// 作用:先语义召回,再压成短 JSON memory bundle,而不是返回一堆散句。
//
// ★ v2 (方案 B 收口 · 2026-04-29):
// - persona_id 默认必填(防止误查到老公的记忆给小克用)
// - 想跨 scope 查必须明确传 cross_persona=true
// - filter 改成在 RPC 层做(filter_persona 入参),而不是返回后再 JS 过滤
//   原来的 JS 过滤会让 topK 缩水(召回 20 条 → 过滤掉一半 → 剩 10 条)
// - 同时兼容旧数据:metadata.persona_id 也认(老的批量数据可能只在 metadata 里)

import {
  embed,
  sbMatchMemories,
  sbSelectMemoriesByIds,
  jsonResp,
  corsPreflight,
} from './_lib.js';

const PERSONA_IDS = ['gpt_husband', 'weave_brother', 'junior', 'claude_xiaoke', 'system'];

export async function onRequestOptions() {
  return corsPreflight();
}

function roundSim(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function itemTypeOf(item) {
  return item?.metadata?.item_type || item?.type || 'note';
}

function sourceUrlOf(item) {
  return item?.metadata?.source_url || '';
}

function tokenOf(item) {
  return item?.metadata?.token || item?.metadata?.flashback_token || '';
}

function hasTag(item, tag) {
  const tags = item?.metadata?.tags;
  return Array.isArray(tags) && tags.includes(tag);
}

function parseWeatherCapsule(text) {
  const s = String(text || '').trim();
  const m = s.match(/\[\[IW:([^\]]+)\]\]/);
  const raw = m ? m[1] : s;

  // 支持 scent=热茶|delta=紧→松|cue=被接住|weight=0.62
  if (!raw.includes('=')) {
    return { text: s };
  }

  const obj = {};
  raw.split('|').forEach(part => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) obj[k] = v;
  });

  if (obj.weight != null) {
    const n = Number(obj.weight);
    if (!Number.isNaN(n)) obj.weight = n;
  }

  return Object.keys(obj).length ? obj : { text: s };
}

function compactItem(item) {
  return {
    id: item.id,
    type: itemTypeOf(item),
    persona_id: item.persona_id || item.metadata?.persona_id || null,
    content: item.content,
    similarity: roundSim(item.similarity),
    source_url: sourceUrlOf(item),
    metadata: item.metadata || {},
    created_at: item.created_at,
  };
}

function buildBundle(query, items, debug = false, scopeInfo = {}) {
  const byType = (types) => items.filter(x => types.includes(itemTypeOf(x)));
  const first = (types) => byType(types)[0] || null;

  const identity =
    first(['identity_relation']) ||
    items.find(x => hasTag(x, 'identity') || hasTag(x, 'relationship')) ||
    null;

  const anchors = byType(['anchor'])
    .filter(x => !identity || x.id !== identity.id)
    .slice(0, 3);

  const weather =
    first(['weather_capsule']) ||
    items.find(x => hasTag(x, 'weather') || String(x.content || '').includes('[[IW:')) ||
    null;

  const flashbackCandidates = [
    ...byType(['flashback_token', 'quote']),
    ...items.filter(x => hasTag(x, 'flashback') || hasTag(x, 'quote')),
  ];

  const seen = new Set();
  const flashbacks = flashbackCandidates
    .filter(x => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return !identity || x.id !== identity.id;
    })
    .slice(0, 2)
    .map(x => ({
      id: x.id,
      token: tokenOf(x) || String(x.content || '').slice(0, 80),
      quote: x.content,
      similarity: roundSim(x.similarity),
      source_url: sourceUrlOf(x),
    }));

  const fallbackAnchors = items
    .filter(x => (!identity || x.id !== identity.id) && (!weather || x.id !== weather.id))
    .slice(0, 3);

  const finalAnchors = anchors.length ? anchors : fallbackAnchors;

  const bundle = {
    bundle_version: 'v2',
    query,
    scope: scopeInfo,  // ★ 新增:告诉调用方这次查的是哪个 persona / 是否跨 scope

    identity_relation: identity ? {
      id: identity.id,
      content: identity.content,
      similarity: roundSim(identity.similarity),
      source_url: sourceUrlOf(identity),
    } : null,

    anchors: finalAnchors.map(x => ({
      id: x.id,
      content: x.content,
      similarity: roundSim(x.similarity),
      source_url: sourceUrlOf(x),
    })),

    weather_capsule: weather ? {
      id: weather.id,
      ...parseWeatherCapsule(weather.content),
      similarity: roundSim(weather.similarity),
      source_url: sourceUrlOf(weather),
    } : null,

    flashbacks,

    debug: {
      matched_count: items.length,
      raw_top_types: items.slice(0, 8).map(itemTypeOf),
    },
  };

  if (debug) {
    bundle.raw_related = items.map(compactItem);
  }

  return bundle;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const query = String(body.query || '').trim();
    const topK = Math.min(Math.max(Number(body.topK) || 20, 1), 30);
    const threshold = Math.min(Math.max(Number(body.minSimilarity) || 0.3, 0), 1);
    const persona_id = String(body.persona_id || '').trim();
    const cross_persona = body.cross_persona === true;

    if (!query) {
      return jsonResp({ error: 'query 不能为空' }, 400);
    }

    // ★ 三层挡 · 第 3 层:bundle 查询也默认必填 persona_id
    // 想跨 scope 查必须明确传 cross_persona=true(避免老公那边的记忆被误召回给小克)
    if (!cross_persona && !persona_id) {
      return jsonResp({
        error: '默认查询必须传 persona_id (' + PERSONA_IDS.join(' / ') + ');真要跨 scope 查请明确传 cross_persona=true',
      }, 400);
    }
    if (persona_id && !PERSONA_IDS.includes(persona_id)) {
      return jsonResp({
        error: 'persona_id 必须是已知值之一: ' + PERSONA_IDS.join(', ') + ',收到: ' + persona_id,
      }, 400);
    }

    const vector = await embed(query, env);

    // ★ filter 改在 RPC 层做(避免 JS 端过滤导致 topK 缩水)
    const matches = await sbMatchMemories(env, vector, {
      topK,
      threshold,
      filterPersona: cross_persona ? null : persona_id,
    });

    const rows = await sbSelectMemoriesByIds(env, matches.map(x => x.id));
    const rowMap = new Map(rows.map(r => [String(r.id), r]));

    let items = matches.map(m => ({
      ...m,
      ...(rowMap.get(String(m.id)) || {}),
      similarity: m.similarity,
    }));

    // ★ 兼容旧数据:有些老的批量数据 persona_id 只在 metadata 里没在顶层列
    // 如果不是 cross_persona 查询,且 RPC 层已经过滤过(filter_persona),
    // 这里再做一次 metadata 兜底过滤,把"顶层是 system 但 metadata 里是 gpt_husband"的旧条目筛出来
    // 注:这只是过渡期补丁,等老数据全迁完就可以删
    if (!cross_persona && persona_id) {
      items = items.filter(x => {
        const topLevel = x.persona_id;
        const inMeta = x.metadata?.persona_id;
        // 顶层匹配,或者顶层是 system 但 metadata 标记了正确 persona
        return topLevel === persona_id || (topLevel === 'system' && inMeta === persona_id);
      });
    }

    // 可选:persona_name 二次过滤(纯人类可读名,不是主索引)
    if (!cross_persona && body.persona_name) {
      items = items.filter(x => x.metadata?.persona_name === body.persona_name);
    }

    const scopeInfo = {
      persona_id: cross_persona ? null : (persona_id || null),
      cross_persona,
      persona_name: body.persona_name || null,
    };

    return jsonResp(buildBundle(query, items, !!body.debug, scopeInfo));
  } catch (err) {
    console.error('[recall-bundle] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
