import express from 'express';
const app = express();
app.use(express.json());

app.post('/api/xhs-card', async (req, res) => {
  try {
    const { url } = req.body;
    const html = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      }
    }).then(r => r.text());
    
    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
    if (!match) return res.json({ ok: false, error: '未找到数据' });
    
    const state = JSON.parse(match[1]);
    const note = state.noteData?.data?.noteData || state.noteData?.normalNotePreloadData;
    if (!note) return res.json({ ok: false, error: '解析失败' });
    
    const images = (note.imageList || []).map(img => {
      let url = img.url.replace(/\\u002F/g, '/');
      if (url.startsWith('//')) url = 'https:' + url;
      return url;
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
    res.json({ ok: false, error: e.message });
  }
});

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

app.listen(3000, () => console.log('Server running on port 3000'));