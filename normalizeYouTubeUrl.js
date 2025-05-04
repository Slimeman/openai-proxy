// utils/normalizeYouTubeUrl.js

function normalizeYouTubeUrl(inputUrl) {
  try {
    const parsedUrl = new URL(inputUrl);
    let videoId = '';

    // Пример: https://youtu.be/FCcaN3QTnSY
    if (parsedUrl.hostname === 'youtu.be') {
      videoId = parsedUrl.pathname.slice(1);
    }

    // Пример: https://www.youtube.com/watch?v=FCcaN3QTnSY
    else if (parsedUrl.hostname.includes('youtube.com')) {
      videoId = parsedUrl.searchParams.get('v');
    }

    // Если удалось извлечь videoId — вернём нормализованный URL
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    } else {
      return null;
    }
  } catch (e) {
    return null;
  }
}

module.exports = normalizeYouTubeUrl;
