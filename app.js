import express from 'express';
const app = express();
app.use(express.json());

app.all('/api/xhs-card', async (req, res) => {
  try {
    const url = req.query.url || req.body.url;
    if (!url) {
      return res.json({ ok: false, error: '请提供 url 参数' });
    }

    // 完整的手机浏览器伪装头
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Referer': 'https://www.xiaohongshu.com/',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    const html = await response.text();

    // 如果返回的 HTML 里包含 "登录" 相关关键词，说明被拦截了
    if (html.includes('登录') || html.includes('login') || html.includes('verify')) {
      return res.json({ ok: false, error: '请求被拦截，可能需要更换 IP 或稍后再试' });
    }

    // 从 HTML 里提取 __INITIAL_STATE__
    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
    if (!match) {
      // 尝试找其他可能的数据源
      const altMatch = html.match(/<script>window\.__INITIAL_STATE__\s*=\s*({.*?})<\/script>/s);
      if (!altMatch) {
        return res.json({ ok: false, error: '未找到数据，页面结构可能已变化' });
      }
      var state = JSON.parse(altMatch[1]);
    } else {
      var state = JSON.parse(match[1]);
    }

    const note = state.noteData?.data?.noteData || state.noteData?.normalNotePreloadData;
    if (!note) {
      return res.json({ ok: false, error: '解析数据失败' });
    }

    // 提取图片 URL
    const images = (note.imageList || []).map(img => {
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
        avatar: note.user?.avatar || '',
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

// 图片转 base64 接口
app.post('/api/xhs-images', async (req, res) => {
  try {
    const { urls } = req.body;
    const results = await Promise.all(urls.map(async (url) => {
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
    }));
    res.json({ ok: true, images: results });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log('Server running on port ' + port));