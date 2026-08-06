// Vercel Serverless Function — dispara o GitHub Action que puxa as tarifas da ANEEL
// (o Action puxa → commita se houve reajuste → o Vercel faz o deploy).
// Precisa da env var GITHUB_DISPATCH_TOKEN no Vercel (PAT com escopo de Actions:write).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'GITHUB_DISPATCH_TOKEN não configurado.',
      hint: 'No Vercel → Settings → Environment Variables, adicione GITHUB_DISPATCH_TOKEN (GitHub PAT com Actions: read/write neste repo).',
    });
  }
  const REPO = process.env.GITHUB_REPO || 'YOUR_GH_USER/asset-forecast-demo';
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/aneel.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'asset-forecast',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (r.status === 204) {
      return res.status(200).json({ ok: true, message: 'Atualização ANEEL disparada. Se houver reajuste, o deploy sai em ~2 min.' });
    }
    const detail = (await r.text()).slice(0, 300);
    return res.status(502).json({ error: `GitHub respondeu ${r.status}`, detail });
  } catch (e) {
    return res.status(502).json({ error: 'Falha ao chamar o GitHub', detail: String(e).slice(0, 200) });
  }
}
