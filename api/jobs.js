// api/jobs.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { urls = [], candidate_profile = '', language = 'da' } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of job URLs' });
    }
    if (!candidate_profile || candidate_profile.trim().length < 30) {
      return res.status(400).json({ error: 'candidate_profile (min 30 chars) required' });
    }

    // --- helpers -------------------------------------------------------------

    // Trim HTML -> tekst og begræns længde (spar tokens)
    function extractPlainText(html, maxLen = 10000) {
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text.slice(0, maxLen);
    }

    async function fetchAndExtract(u) {
      try {
        const page = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await page.text();
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : u;
        const text = extractPlainText(html, 10000); // <= vigtig trim
        return { url: u, title, text };
      } catch {
        return { url: u, title: u, text: '' };
      }
    }

    // Kald Groq med retry hvis vi rammer 429 (rate limit)
    async function callGroqWithRetry(body, maxRetry = 3) {
      for (let i = 0; i <= maxRetry; i++) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });

        if (r.status !== 429) return r; // alt OK eller anden fejl end rate limit

        // 429 -> vent og prøv igen
        const txt = await r.text();
        const retryAfterHeader = r.headers.get('retry-after');
        const m = /try again in (\d+(\.\d+)?)s/i.exec(txt);
        const waitMs = retryAfterHeader
          ? Math.ceil(parseFloat(retryAfterHeader) * 1000)
          : m
            ? Math.ceil(parseFloat(m[1]) * 1000)
            : 3000;
        await new Promise(res => setTimeout(res, waitMs));
      }
      // stadig 429 efter retries
      return new Response(JSON.stringify({ error: 'Rate limit (tokens) – prøv igen senere' }), { status: 429 });
    }

    async function scorePage(p) {
      const prompt = `Sprog: ${language}
Du er en jobmatch-assistent. Givet kandidatprofilen og jobteksten:
- Giv en RELEVANCE_SCORE 0-100 (heltal) for match til profilen.
- Skriv en kort SUMMARY (2-3 linjer) om jobbet og hvorfor det kan være relevant.

Returnér KUN JSON:
{
  "relevance_score": 0,
  "summary": "..."
}

Kandidatprofil:
<<<
${candidate_profile}
>>>

Job (titel: ${p.title}, url: ${p.url}):
<<<
${p.text || '(ingen tekst fundet)'}
>>>`;

      const r = await callGroqWithRetry({
        model: 'llama-3.1-8b-instant',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Returnér KUN valid JSON for matchscore og resume.' },
          { role: 'user', content: prompt }
        ]
      });

      // Når callGroqWithRetry returnerer en Response fra fetch:
      if ('status' in r && typeof r.status === 'number' && r.status !== 200) {
        // enten 429 efter retries eller en anden fejl
        let txt = '';
        try { txt = await r.text(); } catch {}
        return { ...p, relevance_score: 0, summary: `(API-fejl: ${r.status}${txt ? ' ' + txt.slice(0, 200) : ''})` };
      }

      // Vercel fetch Response
      const data = await r.json();
      let json;
      try { json = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); }
      catch { json = { relevance_score: 0, summary: '(parse-fejl)' }; }

      return {
        ...p,
        relevance_score: json.relevance_score ?? 0,
        summary: (json.summary || '').slice(0, 500)
      };
    }

    // Batch-run: kør 2 ad gangen (så 5 links = 2 -> 2 -> 1)
    async function inBatches(arr, size, fn, pauseMs = 1500) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) {
        const chunk = arr.slice(i, i + size);
        const part = await Promise.all(chunk.map(fn));
        out.push(...part);
        if (i + size < arr.length) {
          await new Promise(r => setTimeout(r, pauseMs)); // lille pause mellem batches
        }
      }
      return out;
    }

    // --- workflow ------------------------------------------------------------

    // 1) Hent tekst for alle links
    const rawPages = await Promise.all(urls.map(fetchAndExtract));

    // 2) Score i batches (2 ad gangen)
    const scored = await inBatches(rawPages, 2, scorePage, 1500);

    // 3) Sortér efter score
    scored.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

    // 4) Returnér letvægts-objekter
    const jobs = scored.map(x => ({
      url: x.url,
      title: x.title,
      score: Math.max(0, Math.min(100, parseInt(x.relevance_score || 0, 10))),
      summary: x.summary
    }));

    return res.status(200).json({ jobs });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
