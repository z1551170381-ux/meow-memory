// functions/api/recall-bundle.js
// POST /api/recall-bundle
// body: { query, topK?, minSimilarity?, persona_id?, persona_name?, debug? }
// 作用：先语义召回，再压成短 JSON memory bundle，而不是返回一堆散句。

import {
  embed,
  sbMatchMemories,
  sbSelectMemoriesByIds,
  jsonResp,
  corsPreflight,
} from './_lib.js';

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
    content: item.content,
    similarity: roundSim(item.similarity),
    source_url: sourceUrlOf(item),
    metadata: item.metadata || {},
    created_at: item.created_at,
  };
}

function buildBundle(query, items, debug = false) {
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
    bundle_version: 'v1',
    query,

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

    if (!query) {
      return jsonResp({ error: 'query 不能为空' }, 400);
    }

    const vector = await embed(query, env);
    const matches = await sbMatchMemories(env, vector, { topK, threshold });

    const rows = await sbSelectMemoriesByIds(env, matches.map(x => x.id));
    const rowMap = new Map(rows.map(r => [String(r.id), r]));

    let items = matches.map(m => ({
      ...m,
      ...(rowMap.get(String(m.id)) || {}),
      similarity: m.similarity,
    }));

    // 可选：按 persona 过滤。没有传就不过滤，方便先测试。
    if (body.persona_id) {
      items = items.filter(x => x.metadata?.persona_id === body.persona_id);
    }
    if (body.persona_name) {
      items = items.filter(x => x.metadata?.persona_name === body.persona_name);
    }

    return jsonResp(buildBundle(query, items, !!body.debug));
  } catch (err) {
    console.error('[recall-bundle] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
