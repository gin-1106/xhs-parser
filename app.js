import express from 'express';
const app = express();
app.use(express.json());

// 新增：支持 GET 和 POST 请求
app.all('/api/xhs-card', async (req, res) => {
  try {
    const url = req.query.url || req.body.url;
    if (!url) {
      return res.json({ ok: false, error: '请提供 url 参数' });
    }

    // 1. 先用手机 UA 抓取页面
    const html = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      }
    }).then(r => r.text());

    // 2. 尝试从 JSON-LD 里提取数据（小红书新版结构常用）
    let note = null;
    
    // 方法A：找 JSON-LD 脚本
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]);
        if (jsonLd.image) {
          note = {
            title: jsonLd.headline || jsonLd.name || '',
            desc: jsonLd.description || '',
            author: jsonLd.author?.name || '',
            images: Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image],
            imageCount: Array.isArray(jsonLd.image) ? jsonLd.image.length : 1,
            url: url
          };
        }
      } catch (e) {}
    }

    // 方法B：如果 JSON-LD 没找到，尝试从 __INITIAL_STATE__ 提取（兼容旧版）
    if (!note) {
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
            note = {
              title: noteData.title || '',
              desc: noteData.desc || '',
              author: noteData.user?.nickname || '',
              images: images,
              imageCount: images.length,
              url: url
            };
          }
        } catch (e) {}
      }
    }

    // 方法C：如果上面都没找到，用 Open Graph 元标签（最基础的方法）
    if (!note) {
      const getMeta = (name) => {
        const match = html.match(new RegExp(`<meta\\s+(?:property|name)="${name}"\\s+content="([^"]+)"`, 'i'));
        return match ? match[1] : '';
      };
      const title = getMeta('og:title') || getMeta('twitter:title') || '未知标题';
      const desc = getMeta('og:description') || getMeta('twitter:description') || '';
      const image = getMeta('og:image') || getMeta('twitter:image') || '';
      if (title) {
        note = {
          title: title,
          desc: desc,
          author: '',
          images: image ? [image] : [],
          imageCount: image ? 1 : 0,
          url: url
        };
      }
    }

    if (note) {
      res.json({ ok: true, note: note });
    } else {
      res.json({ ok: false, error: '未能解析该页面，请确认链接是小红书笔记' });
    }

  } catch (e) {
    res.json({ ok: false, error: '请求失败: ' + e.message });
  }
});

// 图片转 base64 接口（保持不变）
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