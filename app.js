import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ========== 公共解析逻辑 ==========

function extractXhsUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const text = input.trim();

  const longMatch = text.match(
    /https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item|notes)\/[0-9a-zA-Z]+[^\s"'<>]*/i
  );
  if (longMatch) return longMatch[0];

  const shortMatch = text.match(
    /https?:\/\/(?:www\.)?xhslink\.(?:com|cn)\/[a-zA-Z0-9\/._~?%&=+-]+/i
  );
  if (shortMatch) return shortMatch[0];

  const shortNoProto = text.match(
    /(?:www\.)?xhslink\.(?:com|cn)\/[a-zA-Z0-9\/._~?%&=+-]+/i
  );
  if (shortNoProto) return 'http://' + shortNoProto[0];

  if (/^https?:\/\//i.test(text)) return text;
  return null;
}

function cleanJsonLike(str) {
  return str
    .replace(/:undefined/g, ':null')
    .replace(/,undefined/g, ',null')
    .replace(/undefined,/g, 'null,')
    .replace(/undefined}/g, 'null}')
    .replace(/\bundefined\b/g, 'null');
}

function pickNote(state) {
  if (!state || typeof state !== 'object') return null;
  const a = state.noteData?.data?.noteData;
  if (a) return a;
  const b = state.noteData?.normalNotePreloadData;
  if (b) return b;
  const map = state.note?.noteDetailMap;
  if (map && typeof map === 'object') {
    const first = Object.values(map)[0];
    if (first?.note) return first.note;
    if (first && (first.title || first.desc || first.imageList)) return first;
  }
  if (state.note?.title || state.note?.imageList) return state.note;
  return null;
}

function num(...vals) {
  for (const v of vals) {
    if (v === 0 || v === '0') return 0;
    if (v == null || v === '') continue;
    const n = Number(String(v).replace(/,/g, ''));
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function normalizeImageUrl(img) {
  let imgUrl =
    img?.urlDefault ||
    img?.url ||
    img?.infoList?.[0]?.url ||
    img?.urlList?.[0] ||
    (typeof img === 'string' ? img : null);
  if (typeof imgUrl !== 'string') return null;
  imgUrl = imgUrl.replace(/\\u002F/g, '/').trim();
  if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
  if (imgUrl.startsWith('http://')) imgUrl = 'https://' + imgUrl.slice(7);
  if (!/^https?:\/\//i.test(imgUrl)) return null;
  return imgUrl;
}

function extractCommentsFromState(state, note) {
  const pools = [
    note?.comments,
    note?.commentList,
    note?.firstComments,
    state?.noteData?.data?.comments,
    state?.comment?.comments,
    state?.comment?.commentList,
    state?.note?.comments,
  ];
  let list = [];
  for (const p of pools) {
    if (Array.isArray(p) && p.length) {
      list = p;
      break;
    }
    if (p && typeof p === 'object') {
      if (Array.isArray(p.list) && p.list.length) {
        list = p.list;
        break;
      }
      if (Array.isArray(p.comments) && p.comments.length) {
        list = p.comments;
        break;
      }
    }
  }
  return list
    .slice(0, 25)
    .map((c) => {
      const u = c.user || c.userInfo || c.author || {};
      return {
        user: u.nickname || u.nickName || u.name || '匿名',
        content: (c.content || c.text || c.commentContent || '').trim(),
        ipLocation: c.ipLocation || c.ip || c.ip_location || '',
      };
    })
    .filter((c) => c.content);
}

function extractNoteId(url = '', note = {}) {
  if (note?.noteId) return String(note.noteId);
  if (note?.id) return String(note.id);
  if (note?.note_id) return String(note.note_id);
  const m = String(url).match(/(?:explore|discovery\/item|notes)\/([0-9a-zA-Z]+)/i);
  return m?.[1] || '';
}

async function parseNote(rawInput) {
  const url = extractXhsUrl(rawInput);
  if (!url) throw new Error('未识别到小红书链接，请粘贴分享文案或链接');

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: 'https://www.xiaohongshu.com/',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
  });

  const finalUrl = response.url || url;
  const html = await response.text();

  if (/登录后查看|请登录|captcha|verify|安全验证|访问频次过高/i.test(html)) {
    throw new Error('请求被拦截，可能需要更换 IP 或稍后再试');
  }

  const match = html.match(
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/
  );
  if (!match) throw new Error('未找到数据，页面结构可能已变化或笔记不可用');

  let state;
  try {
    state = JSON.parse(cleanJsonLike(match[1]));
  } catch (e) {
    throw new Error('JSON 解析失败: ' + e.message);
  }

  const note = pickNote(state);
  if (!note) throw new Error('解析数据失败，数据结构已变化或笔记已删除');

  const interact = note.interactInfo || note.interact || note.interaction || {};
  const likedCount = num(
    note.likedCount, note.likeCount,
    interact.likedCount, interact.likeCount, interact.likes, note.likes
  );
  const commentCount = num(
    note.commentCount, note.commentsCount,
    interact.commentCount, interact.comments
  );
  const collectedCount = num(
    note.collectedCount, note.collectCount,
    interact.collectedCount, interact.collectCount, interact.collects
  );

  const user = note.user || note.userInfo || note.author || {};
  const author = user.nickname || user.nickName || user.name || user.nick_name || '';
  const avatar = user.avatar || user.image || user.headPhoto || '';

  let images = (note.imageList || note.images || note.image_list || [])
    .map(normalizeImageUrl)
    .filter(Boolean);

  if (!images.length) {
    const cover = note.video?.cover || note.video?.image || note.cover || note.coverUrl;
    const c = normalizeImageUrl(cover);
    if (c) images = [c];
  }

  const comments = extractCommentsFromState(state, note);

  return {
    title: note.title || note.displayTitle || '',
    desc: note.desc || note.description || note.content || '',
    author,
    avatar: typeof avatar === 'string' ? avatar : '',
    images,
    imageCount: images.length,
    likedCount,
    commentCount,
    collectedCount,
    comments,
    noteId: extractNoteId(finalUrl, note),
    type: note.type || note.noteType || (note.video ? 'video' : 'normal'),
    url: finalUrl,
  };
}

async function downloadImagesAsBase64(urls, max = 4) {
  const list = (urls || []).slice(0, max);
  const out = [];
  for (const url of list) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          Referer: 'https://www.xiaohongshu.com/',
        },
      });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 2.5 * 1024 * 1024) continue;
      const mime = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
      out.push({ mimeType: mime, data: buf.toString('base64') });
    } catch {
      // 单张失败跳过
    }
  }
  return out;
}

// ========== 原有 HTTP 接口（保持兼容） ==========

app.all('/api/xhs-card', async (req, res) => {
  try {
    const raw = req.query.url || req.body?.url || req.body?.text || '';
    const note = await parseNote(raw);
    res.json({ ok: true, note });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/xhs-images', async (req, res) => {
  try {
    const { urls } = req.body || {};
    if (!urls || !Array.isArray(urls) || !urls.length) {
      return res.json({ ok: false, error: '请提供 urls 数组' });
    }
    const list = urls.slice(0, 12);
    const results = await Promise.all(
      list.map(async (url) => {
        try {
          const response = await fetch(url, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
              Referer: 'https://www.xiaohongshu.com/',
            },
          });
          if (!response.ok) return { url, error: `HTTP ${response.status}` };
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          const mime = response.headers.get('content-type') || 'image/jpeg';
          return { url, base64, mime };
        } catch (err) {
          return { url, error: err.message };
        }
      })
    );
    res.json({ ok: true, images: results });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'xhs-parser', mcp: true });
});

// ========== MCP（给 Kelivo） ==========

function createMcpServer() {
  const server = new McpServer({ name: 'xhs-parser', version: '1.1.0' });

  server.tool(
    'xhs_get_note',
    '解析小红书分享文案或链接。返回标题、正文、作者、点赞评论收藏，并附带若干张配图供识图。输入可以是整段 App 分享文字。',
    {
      text: z.string().describe('小红书分享文案，或链接'),
      max_images: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe('最多给 AI 看几张图，默认 4；填 0 只要文字'),
    },
    async ({ text, max_images = 4 }) => {
      try {
        const note = await parseNote(text);
        const summary = [
          `标题：${note.title || '（无）'}`,
          `作者：${note.author || '（无）'}`,
          `点赞：${note.likedCount}　评论：${note.commentCount}　收藏：${note.collectedCount}`,
          `链接：${note.url}`,
          '',
          '正文：',
          note.desc || '（无正文）',
          '',
          note.comments?.length
            ? '部分评论：\n' +
              note.comments
                .slice(0, 8)
                .map((c) => `- ${c.user}：${c.content}`)
                .join('\n')
            : '（首屏未带评论正文）',
          '',
          `配图共 ${note.imageCount} 张，下方附带前 ${Math.min(max_images, note.imageCount)} 张。`,
        ].join('\n');

        const content = [{ type: 'text', text: summary }];

        if (max_images > 0 && note.images.length) {
          const imgs = await downloadImagesAsBase64(note.images, max_images);
          for (const img of imgs) {
            content.push({
              type: 'image',
              data: img.data,
              mimeType: img.mimeType,
            });
          }
        }

        return { content };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `解析失败：${e.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

const transports = new Map();

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) transports.delete(id);
      };
      const server = createMcpServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('mcp error', e);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send('Invalid or missing mcp-session-id');
    return;
  }
  await transport.handleRequest(req, res);
});

// ========== 启动 ==========

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log('xhs-parser + mcp on port ' + port);
});