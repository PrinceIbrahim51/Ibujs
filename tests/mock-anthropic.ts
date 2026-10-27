import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
export interface MockReply { text: string; stopReason?: string; chunkSize?: number; delayMs?: number }

// A stand-in for the Anthropic Messages API that streams `reply.text` as server-sent events
// and records each request, so tests can check exactly what the SDK sent.
export async function mockAnthropic(reply: (body: Record<string, unknown>) => MockReply) {
  const requests: Recorded[] = [];
  let closedEarly = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ path: req.url ?? '', headers: req.headers, body });
    const { text, stopReason = 'end_turn', chunkSize = 40, delayMs = 0 } = reply(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.on('close', () => { if (!res.writableFinished) closedEarly++; });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < text.length; i += chunkSize) {
      if (res.destroyed) return;
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunkSize) } });
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    closedEarly: () => closedEarly,
    close: () => { server.closeAllConnections(); server.close(); }
  };
}
