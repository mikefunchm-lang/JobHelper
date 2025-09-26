// api/coverletter.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { job_text, candidate_profile, language = 'da', tone = 'professionel', length = 'medium' } = req.body || {};

    if (!job_text || job_text.trim().length < 50) {
      return res.status(400).json({ error: 'job_text is required (min 50 chars)' });
    }
    if (!candidate_profile || candidate_profile.trim().length < 30) {
      return res.status(400).json({ error: 'candidate_profile is required (min 30 chars)' });
    }

    // Tillad både fuld tekst eller URL som job_text:
    let source = job_text.trim();
    const looksLikeUrl = /^https?:\/\/\S+$/i.test(source);
    if (looksLikeUrl) {
      try {
        const page = await fetch(source, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await page.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length > 200) source = text.slice(0, 25000);
      } catch (_) { /* ignore and keep original */ }
    }

    const userPrompt = `Skriv en målrettet jobansøgning.
Sprog: ${language}. Tone: ${tone}. Længde: ${length} (short ~180-220 ord, medium ~250-350 ord, long ~400-550 ord).
Regler:
- Brug et naturligt, menneskeligt sprog uden floskler.
- Brug 2-3 afsnit + bullets (maks 5 bullets) med konkrete resultater/kompetencer.
- Spejl vigtige krav fra jobopslaget, men undgå at kopiere sætninger ordret.
- Fremhæv relevant erfaring fra kandidaten med tal/effekt hvis muligt.
- Afslut med kort call-to-action (glæder mig til at høre nærmere, mvh).
- Returnér KUN ren brødtekst (ingen JSON, ingen forklaringer).

Kandidatprofil (resumé + 5-8 nøglepunkter):
<<<
${candidate_profile}
>>>

Jobopslag (tekst eller udtrukket sideindhold):
<<<
${source}
>>>`;

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0.4, // lidt mere variation end brief
        messages: [
          { role: 'system', content: 'Du er en erfaren jobcoach der skriver klare, præcise ansøgninger.' },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(500).json({ error: 'LLM error', detail: txt });
    }

    const data = await r.json();
    const letter = data?.choices?.[0]?.message?.content?.trim() || '';
    return res.status(200).json({ letter });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
