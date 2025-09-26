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

    // Hent HTML og lav meget simpel tekstudtræk
    async function fetchAndExtract(u) {
      try {
        const page = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await page.text();
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g,' ').trim() : u;

        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 25000);

        return { url: u, title, text };
      } catch {
        return { url: u, title: u, text: '' };
      }
    }

    const rawPages = await Promise.all(urls.map(fetchAndExtract));

    // Bed LLM om at give relevansscore + 2-3 linjers resume
    async function scorePage(p) {
      const prompt = `Sprog: ${language}
Du er en jobmatch-assistent. Givet kandidatprofilen og jobteksten:
- Giv en RELEVANCE_SCORE 0-100 (heltal) for hvor godt jobbet matcher profilen.
- Skriv en kort SUMMARY (2-3 linjer) der beskriver jobbet og hvorfor det kan være relevant.

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
${p.text}
>>>`;

      // Groq kald
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Returnér KUN valid JSON for matchscore og resume.' },
            { role: 'user', content: prompt }
          ]
        })
      });

      if (!r.ok) return { ...p, relevance_score: 0, summary: '(fejl ved kald)' };
      const data = await r.json();
      let json;
      try { json = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); }
      catch { json = { relevance_score: 0, summary: '(parse-fejl)' }; }
      return { ...p, relevance_score: json.relevance_score ?? 0, summary: json.summary ?? '' };
    }

    const scored = await Promise.all(rawPages.map(scorePage));

    // Sortér efter score desc
    scored.sort((a,b) => (b.relevance_score||0) - (a.relevance_score||0));

    // Trim summary længde
    const result = scored.map(x => ({
      url: x.url,
      title: x.title,
      score: Math.max(0, Math.min(100, parseInt(x.relevance_score || 0, 10))),
      summary: (x.summary || '').slice(0, 500)
    }));

    return res.status(200).json({ jobs: result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
