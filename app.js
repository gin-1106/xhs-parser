import express from 'express';
const app = express();
app.use(express.json());

// 从分享文案或纯链接里提取可用的小红书链接
function extractXhsUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const text = input.trim();

  // 已经是完整链接
  const longMatch = text.match(/https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item|notes)\/[0-9a-zA-Z]+[^\s]*/i);
  if (longMatch) return longMatch[0];

  // 短链 xhslink.com / xhslink.cn
  const shortMatch = text.match(/https?:\/\/xhslink\.(?:com|cn)\/[a-zA-Z0-9\/._?%&=+-]+/i);
  if (shortMatch) return shortMatch[0];

  // 有时是不带协议的
  const shortNoProto = text.match(/xhslink\.(?:com|cn)\/[a-zA-Z0-9\/._?%&=+-]+/i);
  if (shortNoProto) return 'http://' + shortNoProto[0];

  // 整段就是一个链接
  if (/^https?:\/\//i.test(text)) return text;

  return null;
}

app.all('/api/xhs-card', async (req, res) => {
  try {
    const raw = req.query.url || req.body.url || req.body.text || '';
    const url = extractXhsUrl(raw);

    if (!url) {
      return res.json({ ok: false, error: '未识别到小红书链接，请粘贴分享文案或链接' });
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Referer': 'https://www.xiaohongshu.com/',
        'Upgrade-Insecure-Requests': '1'
      },
      redirect: 'follow'
    });

    const finalUrl = response.url || url;
    const html = await response.text();

    if (html.includes('登录后查看') || html.includes('请登录') || html.includes('captcha') || html.includes('verify')) {
      return res.json({ ok: false, error: '请求被拦截，可能需要更换 IP 或稍后再试' });
    }

    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/);
    if (!match) {
      return res.json({ ok: false, error: '未找到数据，页面结构可能已变化' });
    }

    let rawState = match[1]
      .replace(/:undefined/g, ':null')
      .replace(/,undefined/g, ',null')
      .replace(/undefined,/g, 'null,')
      .replace(/undefined}/g, 'null}');

    let state;
    try {
      state = JSON.parse(rawState);
    } catch (e) {
      return res.json({ ok: false, error: 'JSON 解析失败: ' + e.message });
    }

    let note =
      state.noteData?.data?.noteData ||
      state.noteData?.normalNotePreloadData ||
      (state.note?.noteDetailMap && Object.values(state.note.noteDetailMap)[0]?.note) ||
      null;

    if (!note) {
      return res.json({ ok: false, error: '解析数据失败，数据结构已变化' });
    }

    const interact = note.interactInfo || note.interact || {};
    const likedCount = note.likedCount ?? interact.likedCount ?? interact.likeCount ?? note.likeCount ?? 0;
    const commentCount = note.commentCount ?? interact.commentCount ?? note.commentsCount ?? 0;
    const collectedCount = note.collectedCount ?? interact.collectedCount ?? interact.collectCount ?? note.collectCount ?? 0;

    const user = note.user || note.userInfo || {};
    const author = user.nickname || user.nickName || user.name || '';
    const avatar = user.avatar || user.image || user.headPhoto || '';

    const images = (note.imageList || note.images || []).map(img => {
      let imgUrl = img.urlDefault || img.url || img.infoList?.[0]?.url || img;
      if (typeof imgUrl === 'string') {
        imgUrl = imgUrl.replace(/\\u002F/g, '/');
        if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
        if (imgUrl.startsWith('http://')) imgUrl = imgUrl.replace('http://', 'https://');
      }
      return imgUrl;
    }).filter(u => typeof u === 'string' && u.startsWith('http'));

    let comments = [];
    const rawComments =
      note.comments ||
      note.commentList ||
      state.noteData?.data?.comments ||
      state.comment?.comments ||
      [];

    if (Array.isArray(rawComments)) {
      comments = rawComments.slice(0, 25).map(c => {
        const u = c.user || c.userInfo || {};
        return {
          user: u.nickname || u.nickName || u.name || '匿名',
          content: c.content || c.text || '',
          ipLocation: c.ipLocation || c.ip || ''
        };
      }).filter(c => c.content);
    }

    res.json({
      ok: true,
      note: {
        title: note.title || '',
        desc: note.desc || note.description || '',
        author,
        avatar,
        images,
        imageCount: images.length,
        likedCount: Number(likedCount) || 0,
        commentCount: Number(commentCount) || 0,
        collectedCount: Number(collectedCount) || 0,
        comments,
        url: finalUrl
      }
    });

  } catch (e) {
    res.json({ ok: false, error: '请求失败: ' + e.message });
  }
});

app.post('/api/xhs-images', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) {
      return res.json({ ok: false, error: '请提供 urls 数组' });
    }

    const results = await Promise.all(urls.map(async (url) => {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Referer': 'https://www.xiaohongshu.com/'
          }
        });
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const mime = response.headers.get('content-type') || 'image/jpeg';
        return { url, base64, mime };
      } catch (err) {
        return { url, error: err.message };
      }
    }));

    res.json({ ok: true, images: results });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log('Server running on port ' + port));