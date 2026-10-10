import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { PoseAnalysisSchema, type AnalyzeRequest, type AnalyzeResponse } from '../shared/schema.ts';
import { SYSTEM_PROMPT, userInstructions } from './prompt.ts';

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';
const EFFORT = (process.env.CLAUDE_EFFORT ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: '30mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, serverKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.post('/api/analyze', async (req, res) => {
  const body = req.body as AnalyzeRequest;
  if (!body?.image?.data) {
    res.status(400).json({ error: 'Missing image.' });
    return;
  }

  // A key typed into the UI is used only when the server has none of its own.
  const headerKey = req.header('x-anthropic-key')?.trim();
  const client = process.env.ANTHROPIC_API_KEY || !headerKey ? new Anthropic() : new Anthropic({ apiKey: headerKey });

  const isRefine = Boolean(body.render && body.current);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: 'image', source: { type: 'base64', media_type: body.image.media_type, data: body.image.data } },
  ];
  if (isRefine && body.render) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: body.render.media_type, data: body.render.data },
    });
  }
  content.push({
    type: 'text',
    text: userInstructions({ hasDetector: Boolean(body.detector?.length), isRefine, note: body.note }),
  });
  if (body.detector?.length) {
    const rounded = body.detector.map((l) => ({
      name: l.name,
      u: +l.u.toFixed(3),
      v: +l.v.toFixed(3),
      x: +l.x.toFixed(3),
      y: +l.y.toFixed(3),
      z: +l.z.toFixed(3),
      visibility: +l.visibility.toFixed(2),
    }));
    content.push({
      type: 'text',
      text: `Detector landmarks (already converted to the camera frame described above):\n${JSON.stringify(rounded)}`,
    });
  }
  if (isRefine && body.current) {
    content.push({ type: 'text', text: `Current mannequin keypoints:\n${JSON.stringify(body.current)}` });
  }

  try {
    // Streamed because long thinking + a large max_tokens can exceed a non-streaming request's limits.
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT, format: betaZodOutputFormat(PoseAnalysisSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
    // Stop generating (and billing) if the browser goes away before we answer.
    res.on('close', () => {
      if (!res.writableEnded) stream.abort();
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      res.status(422).json({ error: 'Claude declined to analyze this image.', details: message.stop_details });
      return;
    }
    if (message.stop_reason === 'max_tokens') {
      res.status(502).json({ error: 'Claude ran out of output tokens before finishing the analysis.' });
      return;
    }
    if (!message.parsed_output) {
      res.status(502).json({ error: 'Claude returned an analysis that did not match the schema.' });
      return;
    }

    const payload: AnalyzeResponse = {
      analysis: message.parsed_output,
      model: message.model,
      usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
    };
    res.json(payload);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      res.status(401).json({ error: 'No valid Anthropic API key. Set ANTHROPIC_API_KEY on the server or enter a key in the app.' });
    } else if (err instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: 'Rate limited by the Claude API. Try again in a moment.' });
    } else if (err instanceof Anthropic.BadRequestError) {
      res.status(400).json({ error: `Claude API rejected the request: ${err.message}` });
    } else if (err instanceof Anthropic.APIError) {
      res.status(err.status ?? 502).json({ error: `Claude API error: ${err.message}` });
    } else if (err instanceof Anthropic.AnthropicError) {
      // Raised before any request is sent, e.g. when no credentials are configured.
      res.status(401).json({ error: `No Anthropic credentials: set ANTHROPIC_API_KEY on the server or enter a key in the app. (${err.message})` });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Unexpected server error.' });
    }
  }
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`3dposer API listening on http://localhost:${PORT} (model ${MODEL})`);
});
