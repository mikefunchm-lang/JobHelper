// api/brief.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { job_text, language = 'da' } = req.body || {};
    if (!job_text || job_text.trim().length < 30) {
      return res.status(400).json({ error: 'job_text is required (min 30 chars)' });
    }

    const userPrompt = `Sprog: ${language}
Ekstrahér en kandidat-brief fra jobopslaget nedenfor.
Schema:
{
  "role_title": "string",
  "seniority": "junior|mid|senior|lead|director|unknown",
  "team_context": "string",
  "domain": "finance|saas|ecommerce|public|other",
  "must_haves": ["string"],
  "nice_to_haves": ["string"],
  "kpis": ["string"],
  "screen_questions": ["string"],
  "red_flags": ["string"],
  "candidate_pitch_30s": "string",
  "keywords": ["string"]
}
Rules:
- Afled seniority ud fra ansvar/krav (hvis tvivl: "unknown").
- Max 6 must_haves, max 6 nice_to_haves, max 5 screen_questions.
- Brug konkrete, jobnære formuleringer. Ingen fluff.
- Returnér KUN JSON. Ingen forklaringer.

Job posting:
<<<
${job_text}
>>>`;

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
          { role: 'system', content: 'Du er en striks jobanalytiker. Returnér KUN valid JSON der matcher skemaet.' },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(500).json({ error: 'LLM error', detail: txt });
    }

    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';

    let brief;
    try { brief = JSON.parse(raw); }
    catch {
      brief = {
        role_title: 'Ukendt', seniority: 'unknown', team_context: '',
        domain: 'other', must_haves: [], nice_to_haves: [], kpis: [],
        screen_questions: [], red_flags: [], candidate_pitch_30s: '', keywords: []
      };
    }

    return res.status(200).json({ brief });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}