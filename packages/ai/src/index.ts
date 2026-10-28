import Anthropic from '@anthropic-ai/sdk';
import { HttpError, rateLimit, s, type Handler } from '@ibumomujs/server';
import { IbuError } from '@ibumomujs/ui';

// Server-only Claude helpers. Your API key stays on the server, and the public route has
// input limits, per-IP rate limits, a concurrency cap and stops generating (and billing)
// when the visitor disconnects.

export const DEFAULT_MODEL = 'claude-opus-5-5';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Message = Anthropic.Beta.BetaMessageParam;

export interface AIOptions {
  model?: string;
  system?: string;
  effort?: Effort;
  maxTokens?: number;
  // Defaults to the ANTHROPIC_API_KEY environment variable (put it in .env, never in code).
  apiKey?: string;
  // Inject a preconfigured client (tests, proxies, other platforms).
  client?: Anthropic;
}

export interface RouteOptions {
  system?: string;
  effort?: Effort;
  maxTokens?: number;
  maxInputChars?: number;
  maxMessages?: number;
  requestsPerMinute?: number;
  maxConcurrent?: number;
}

export const REFUSAL_NOTICE = '\n\n[The AI declined to answer this request.]';

export function createAI(options: AIOptions = {}) {
  if (typeof window !== 'undefined') {
    throw new IbuError('IBU801', '@ibumomujs/ai was loaded in the browser, which would expose your API key.', 'Use it in src/server.ts and call your route from the page with api.stream("/api/ask", { prompt }).');
  }
  let client = options.client;
  const getClient = () => {
    if (client) return client;
    if (!options.apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new IbuError('IBU802', 'No Anthropic API key found.', 'Create one at https://platform.claude.com, add ANTHROPIC_API_KEY=... to your .env file, and restart the server.');
    }
    return client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  };
  const model = options.model ?? DEFAULT_MODEL;

  const request = (input: string | Message[], overrides: Partial<RouteOptions> = {}, signal?: AbortSignal) => getClient().beta.messages.stream({
    model,
    max_tokens: overrides.maxTokens ?? options.maxTokens ?? 16_000,
    ...(overrides.system ?? options.system ? { system: overrides.system ?? options.system } : {}),
    messages: typeof input === 'string' ? [{ role: 'user', content: input }] : input,
    output_config: { effort: overrides.effort ?? options.effort ?? 'medium' },
    // If a safety classifier declines, Anthropic retries on its recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default'
  }, { signal });

  // Yields the answer as it is generated. Adds REFUSAL_NOTICE if the model declines.
  async function* stream(input: string | Message[], overrides: Partial<RouteOptions> = {}, signal?: AbortSignal): AsyncGenerator<string> {
    const response = request(input, overrides, signal);
    for await (const event of response) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
    }
    const final = await response.finalMessage();
    if (final.stop_reason === 'refusal') yield REFUSAL_NOTICE;
  }

  // The whole answer as one string.
  async function ask(input: string | Message[], overrides: Partial<RouteOptions> = {}): Promise<string> {
    let text = '';
    for await (const chunk of stream(input, overrides)) text += chunk;
    return text;
  }

  // A ready-made POST handler: app.post('/api/ask', ai.route({ system: 'You help with recipes.' }))
  // Body: { prompt: "..." } or { messages: [{ role: 'user' | 'assistant', content: "..." }] }.
  // Responds with streamed plain text; read it in the page with api.stream().
  function route(routeOptions: RouteOptions = {}): Handler {
    const maxInputChars = routeOptions.maxInputChars ?? 4000;
    const Body = s.object({
      prompt: s.string({ min: 1, max: maxInputChars }).optional(),
      messages: s.array(s.object({ role: s.enum(['user', 'assistant']), content: s.string({ min: 1, max: maxInputChars }) }), { min: 1, max: routeOptions.maxMessages ?? 20 }).optional()
    });
    const limiter = rateLimit({ limit: routeOptions.requestsPerMinute ?? 10, windowMs: 60_000 });
    const maxConcurrent = routeOptions.maxConcurrent ?? 4;
    let active = 0;
    return async ctx => {
      await limiter(ctx, async () => {});
      const body = await ctx.body(Body);
      const input = body.messages ?? body.prompt;
      if (!input) throw new HttpError(400, 'Send { prompt } or { messages }', { code: 'IBU415' });
      if (Array.isArray(input) && input[input.length - 1].role !== 'user') throw new HttpError(400, 'The last message must be from the user', { code: 'IBU415' });
      if (active >= maxConcurrent) throw new HttpError(503, 'The AI is busy, please try again in a moment', { code: 'IBU803' });
      active++;
      const abort = new AbortController();
      const onClose = () => { if (!ctx.res.writableEnded) abort.abort(); };
      ctx.res.on('close', onClose);
      try {
        const chunks = stream(input, { maxTokens: 4096, ...routeOptions }, abort.signal);
        // Wait for the first chunk before sending headers, so upstream errors still produce a clean error response.
        const first = await chunks.next();
        ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        if (!first.done) ctx.res.write(first.value);
        for await (const chunk of chunks) ctx.res.write(chunk);
        ctx.res.end();
      } catch (err) {
        // The visitor left: generation was cancelled, so there is nobody to answer.
        if (abort.signal.aborted) { ctx.res.end(); return; }
        if (ctx.res.headersSent) { ctx.res.end('\n\n[The answer was interrupted.]'); throw err; }
        if (err instanceof IbuError) throw err;
        if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'The AI is busy, please try again in a moment', { code: 'IBU803' });
        throw Object.assign(new HttpError(502, 'The AI service is unavailable'), { cause: err });
      } finally {
        active--;
        ctx.res.off('close', onClose);
      }
    };
  }

  return { ask, stream, route, model };
}
