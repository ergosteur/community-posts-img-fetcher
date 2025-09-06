export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');
    if (!target) return new Response('Missing url', { status: 400 });

    // Basic allowlist
    if (!/^https:\/\/(www\.)?youtube\.com\//.test(target)) {
      return new Response('Forbidden host', { status: 403 });
    }

    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*'
      }
    });
  }
};