// functions/mcp.js
// /mcp 路由 —— 直接复用 /api/mcp 的实现,避免两份逻辑各自漂移、对不齐。
//
// Cloudflare Pages 的路由 = 文件路径:本文件对应网址 /mcp,
// functions/api/mcp.js 对应 /api/mcp。以前这两个文件各存了一整套相同逻辑,
// 一改就容易只改一边、对不齐(fact/preference 当初就只进了 api 那份)。
// 现在两个门牌、同一套实现:要改 MCP 逻辑,只改 api/mcp.js 一处即可。
export { onRequestOptions, onRequestGet, onRequestPost } from './api/mcp.js';
