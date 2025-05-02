const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); // ✅ Правильно

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// конст для Downsub
const summaryCache = {};

function extractVideoId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('v');
  } catch {
    return null;
  }
}

// 🌍 Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// DOWNSub
app.post('/srt-summary', async (req, res) => {
  const { url } = req.body;
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Некорректная ссылка YouTube' });

  try {
    const downsubRes = await fetch('https://api.downsub.com/download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DOWNSUB_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url })
    });

    const downsubData = await downsubRes.json();
    const subtitles = downsubData?.data?.subtitles || [];

    // 🔍 Сначала пробуем на русском, потом на английском
    let selectedSub = subtitles.find(sub => sub.language.toLowerCase().includes('russian')) ||
                      subtitles.find(sub => sub.language.toLowerCase().includes('english'));

    const srtUrl = selectedSub?.formats?.find(f => f.format === 'srt')?.url;
    const txtUrl = selectedSub?.formats?.find(f => f.format === 'txt')?.url;
    const vttUrl = selectedSub?.formats?.find(f => f.format === 'vtt')?.url;

    if (!txtUrl) {
      return res.status(404).json({ error: 'TXT субтитры на русском и английском не найдены' });
    }

    const txtText = await (await fetch(txtUrl)).text();
    const plainText = txtText.trim();

    const meta = {
      title: downsubData.data.title,
      description: downsubData.data.metadata?.description,
      thumbnail: downsubData.data.thumbnail,
      author: downsubData.data.metadata?.author,
      publishDate: downsubData.data.metadata?.publishDate,
    };

    // Чанкование текста, если он слишком длинный
    const chunks = [];
    const chunkSize = 8000; // символов
    for (let i = 0; i < plainText.length; i += chunkSize) {
      chunks.push(plainText.slice(i, i + chunkSize));
    }

    let intermediateSummaries = [];

    for (let chunk of chunks) {
      const chunkPrompt = `Вот часть субтитров видео:

${chunk}

Сделай краткое саммари этой части. Пиши на русском.`;

      const gptRes = await fetch(`http://localhost:${PORT}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: 'Ты ассистент успешного Ютубера интервьюера, который делает краткое, понятное саммари по видео. Твоя задача, сделать такое саммари, что бы можно было полностью понять видео и главных его частей. Постарайся определить интервью это или нет, если это интервью, то выведи все вопросы которые задал интервьюер.'
            },
            {
              role: 'user',
              content: chunkPrompt
            }
          ]
        })
      });

      const gptData = await gptRes.json();
      const summary = gptData.choices?.[0]?.message?.content || '';
      intermediateSummaries.push(summary);
    }

    // Объединяем все мини-саммари и делаем итоговое
    const finalPrompt = `Вот несколько кратких саммари частей видео:

${intermediateSummaries.join('\n\n')}

На основе этого сделай финальное саммари и если это интервью, то списко вопросов интервьюера. Пиши на русском.`;

    const finalRes = await fetch(`http://localhost:${PORT}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'Ты ассистент, который делает очень удобное для чтения и понятное саммари по видео.'
          },
          {
            role: 'user',
            content: finalPrompt
          }
        ]
      })
    });

    const finalData = await finalRes.json();
    const finalSummary = finalData.choices?.[0]?.message?.content || 'Саммари не получено';

    summaryCache[videoId] = { plainText, summary: finalSummary, meta };

    res.json({
      ...meta,
      summary: finalSummary,
      srtUrl,
      txtUrl,
      vttUrl
    });

  } catch (error) {
    console.error('Ошибка в /srt-summary:', error);
    res.status(500).json({ error: 'Ошибка сервера при обработке субтитров' });
  }
});


// ✅ OpenAI Proxy (остается как есть)
app.post('/', async (req, res) => {
  try {
    const { messages } = req.body;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.8
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Новый маршрут для получения заголовка с YouTube
app.get('/analyze-video', async (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required' });
  }

  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`;
    const response = await fetch(videoUrl);
    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      return res.status(404).json({ error: 'Видео не найдено' });
    }

    const item = data.items[0];
    const stats = item.statistics;
    const snippet = item.snippet;
    const duration = parseDuration(item.contentDetails.duration); // ISO 8601 → минуты

    const views = parseInt(stats.viewCount || 0);
    const likes = parseInt(stats.likeCount || 0);
    const comments = parseInt(stats.commentCount || 0); // ✅ теперь есть
    const engagement = ((likes + comments) / views) * 100 || 0;
    const revenue = [views * 0.001, views * 0.005];
    const publishDate = new Date(snippet.publishedAt);
    const now = new Date();
    const ageInDays = Math.max((now - publishDate) / (1000 * 60 * 60 * 24), 1);
    const avgViewsPerDay = views / ageInDays;

    res.json({
      channelTitle: snippet.channelTitle,
      title: snippet.title,
      description: snippet.description, // ✅ добавили описание
      thumbnail: snippet.thumbnails?.medium?.url,
      language: snippet.defaultAudioLanguage || 'Не указано',
      publishedAt: snippet.publishedAt,
      duration: duration.toFixed(2),
      views,
      likes,
      comments, // ✅ теперь возвращаем
      engagement: engagement.toFixed(2),
      revenueRange: revenue.map(r => `$${r.toFixed(2)}`),
      avgViewsPerDay: Math.round(avgViewsPerDay),
      category: snippet.categoryId,
      growthStatus: avgViewsPerDay < 30 ? 'низкий' : avgViewsPerDay < 100 ? 'средний' : 'хороший',
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка при анализе видео' });
  }
});

function parseDuration(isoDuration) {
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  return hours * 60 + minutes + seconds / 60;
}

// ✅ Новый SEO-оптимизатор
app.get('/seo-optimize', async (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required' });
  }

  try {
    // 1. Получаем title + description через внутренний API
    const metaRes = await fetch(`http://localhost:${PORT}/analyze-video?videoId=${videoId}`);
    const meta = await metaRes.json();

    if (meta.error) {
      return res.status(500).json({ error: 'Ошибка при получении данных видео' });
    }

    const prompt = `
Ты лучший Ютубер и SEO-кликбейт специалист в мире.
На основе данных ниже сделай:

1. 5 кликбейтных названий для превью (Не более 3х слов)
2. 5 SEO-оптимизированных заголовков
3. SEO-оптимизированное описание для видео
4. Определи есть ли в описании таймкоды и если есть, то дай ещё SEO оптимизированные таймкоды
5. Сделай через запятую, без значка хештега, список ключевых слов для блока ключевых слов на Youtube

Заголовок: ${meta.title}
Описание: ${meta.description}
    `.trim();

    // 2. Отправляем в OpenAI через / (локальный proxy)
    const gptRes = await fetch(`http://localhost:${PORT}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] })
    });

    const gptData = await gptRes.json();

    if (!gptData.choices) {
      return res.status(500).json({ error: 'Ошибка от OpenAI' });
    }

    res.json({
      originalTitle: meta.title,
      originalDescription: meta.description,
      optimizedText: gptData.choices[0].message.content
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка при SEO оптимизации' });
  }
});

// ✅ Ютуб тренды за 7 дней
app.get('/youtube-trends', async (req, res) => {
  const query = req.query.query;
  if (!query) return res.status(400).json({ error: 'query is required' });

  const publishedAfter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // последние 7 дней

  try {
    // 1. Получаем список видео по ключевику
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&maxResults=20&order=viewCount&publishedAfter=${publishedAfter}&type=video&regionCode=RU&key=${YOUTUBE_API_KEY}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    const videoIds = searchData.items.map(item => item.id.videoId).join(',');

    // 2. Получаем доп. данные по видео (длительность + просмотры)
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const detailsRes = await fetch(detailsUrl);
    const detailsData = await detailsRes.json();

    // 3. Возвращаем клиенту данные
    res.json({ items: detailsData.items.map(item => ({
      id: item.id,
      snippet: item.snippet,
      statistics: item.statistics,
      contentDetails: item.contentDetails
    }))});
  } catch (error) {
    console.error('Ошибка при получении YouTube трендов:', error);
    res.status(500).json({ error: 'Ошибка при запросе к YouTube API' });
  }
});

// ✅ подключение Gemini
// ✅ Новый маршрут для анализа YouTube-ссылки с помощью Gemini
app.post('/gemini-summary', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  const prompt = `
Отправляю ссылку на Youtube видео: ${url}
Сделай мне саммари
`.trim();

  try {
const result = await genAI.models.generateContent({
  model: 'models/gemini-2.5-pro-preview-03-25',
  contents: [
    {
      role: 'user',
      parts: [{ text: prompt }]
    }
  ]
});

console.log('Gemini raw:', JSON.stringify(result, null, 2));

const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || 'Ответ не получен';
res.json({ summary: text });

  } catch (error) {
    console.error('Gemini error:', error);
    res.status(500).json({ error: error.message || 'Ошибка от Gemini API' });
  }
});



app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});



