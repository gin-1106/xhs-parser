import express from 'express';
const app = express();
app.use(express.json());

// 小红书笔记数据抓取接口
app.all('/api/xhs-card', async (req, res) => {
  try {
    const url = req.query.url || req.body.url;
    if (!url) {
      return res.json({ ok: false, error: '请提供 url 参数' });
    }

    // 从 URL 中提取笔记 ID
    const noteIdMatch = url.match(/\/explore\/([a-zA-Z0-9]+)/);
    if (!noteIdMatch) {
      return res.json({ ok: false, error: '无法识别笔记 ID' });
    }
    const noteId = noteIdMatch[1];

    // 使用小红书官方 API（无需登录）
    const apiUrl = `https://www.xiaohongshu.com/api/sns/web/v1/feed?note_id=${noteId}`;
    
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.xiaohongshu.com/',
        'Accept': 'application/json'
      }
    });

    const data = await response.json();
    
    if (data.code !== 0) {
      // API 失败，回退到 HTML 解析方式
      return fallbackParse(url, res);
    }

    const note = data.data?.note;
    if (!note) {
      return fallbackParse(url, res);
    }

    // 提取图片 URL
    const images = (note.images || []).map(img => {
      let imgUrl = img.url || img;
      if (typeof imgUrl === 'string') {
        imgUrl = imgUrl.replace(/\\u002F/g, '/');
        if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
      }
      return imgUrl;
    });

    res.json({
      ok: true,
      note: {
        title: note.title || '',
        desc: note.desc || '',
        author: note.user?.nickname || '',
        images: images,
        imageCount: images.length,
        likedCount: note.likedCount || 0,
        commentCount: note.commentCount || 0,
        collectedCount: note.collectedCount || 0,
        url: url
      }
    });

  } catch (e) {
    res.json({ ok: false, error: '请求失败: ' + e.message });
  }
});

// 备用方案：HTML 解析（当 API 失败时使用）
async function fallbackParse(url, res) {
  try {
    const html = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      }
    }).then(r => r.text());

    // 尝试从 __INITIAL_STATE__ 提取
    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
    if (match) {
      try {
        const state = JSON.parse(match[1]);
        const noteData = state.noteData?.data?.noteData || state.noteData?.normalNotePreloadData;
        if (noteData) {
          const images = (noteData.imageList || []).map(img => {
            let imgUrl = img.url || img;
            if (typeof imgUrl === 'string') {
              imgUrl = imgUrl.replace(/\\u002F/g, '/');
              if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
            }
            return imgUrl;
          });
          return res.json({
            ok: true,
            note: {
              title: noteData.title || '',
              desc: noteData.desc || '',
              author: noteData.user?.nickname || '',
              images: images,
              imageCount: images.length,
              likedCount: noteData.likedCount || 0,
              commentCount: noteData.commentCount || 0,
              collectedCount: noteData.collectedCount || 0,
              url: url
            }
          });
        }
      } catch (e) {}
    }

    // 最后的备用：Open Graph 元标签
    const getMeta = (name) => {
      const match = html.match(new RegExp(`<meta\\s+(?:property|name)="${name}"\\s+content="([^"]+)"`, 'i'));
      return match ? match[1] : '';
    };
    const title = getMeta('og:title') || getMeta('twitter:title') || '未知标题';
    const desc = getMeta('og:description') || getMeta('twitter:description') || '';
    const image = getMeta('og:image') || getMeta('twitter:image') || '';

    if (title) {
      return res.json({
        ok: true,
        note: {
          title: title,
          desc: desc,
          author: '',
          images: image ? [image] : [],
          imageCount: image ? 1 : 0,
          url: url
        }
      });
    }

    res.json({ ok: false, error: '未能解析该页面' });
  } catch (e) {
    res.json({ ok: false, error: '备用解析失败: ' + e.message });
  }
}

// 图片转 base64 接口
app.post('/api/xhs-images', async (req, res) => {
  try {
    const { urls } = req.body;
    const results = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const mime = response.headers.get('content-type') || 'image/jpeg';
      return { url, base64, mime };
    }));
    res.json({ ok: true, images: results });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log('Server running on port ' + port));