export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  try {
    const url = new URL(request.url);
    const auth = request.headers.get('Authorization') || '';
    const key = auth.replace('Bearer ', '').trim() || url.searchParams.get('key');

    if (!key) {
      return new Response(JSON.stringify({ error: { message: 'Missing API Key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    let requestData = {};
    if (request.method === 'POST') {
      requestData = await request.json();
    }

    const reqModel = requestData.model || '';
    const modelMatch = reqModel.match(/(gemini-[\w.\-]+)/);
    const model = modelMatch ? modelMatch[1] : 'gemini-2.5-flash';

    const messages = requestData.messages || [];
    let systemInstruction = null;
    const contents = [];

    for (const m of messages) {
      let textContent = '';
      if (typeof m.content === 'string') {
        textContent = m.content;
      } else if (Array.isArray(m.content)) {
        textContent = m.content.map(c => c.text || '').join('\n');
      }

      if (m.role === 'system') {
        systemInstruction = { parts: [{ text: textContent }] };
      } else {
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
          contents[contents.length - 1].parts[0].text += '\n' + textContent;
        } else {
          contents.push({ role, parts: [{ text: textContent }] });
        }
      }
    }

    const payload = {
      contents,
      generationConfig: {
        temperature: requestData.temperature ?? 0.7,
        maxOutputTokens: requestData.max_tokens ?? 8192,
      },
    };
    if (systemInstruction) payload.systemInstruction = systemInstruction;

    const isStream = requestData.stream === true;
    const geminiMethod = isStream ? 'streamGenerateContent' : 'generateContent';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${geminiMethod}?key=${key}${isStream ? '&alt=sse' : ''}`;

    const resp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errorData = await resp.json().catch(() => ({}));
      const errorMessage = errorData?.error?.message || JSON.stringify(errorData);
      return new Response(JSON.stringify({
        error: { message: `Gemini API Error: ${errorMessage}`, type: 'api_error' },
      }), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (isStream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      (async () => {
        const reader = resp.body.getReader();
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const jsonStr = line.slice(6);
                if (jsonStr === '[DONE]') continue;
                try {
                  const data = JSON.parse(jsonStr);
                  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
                  if (text) {
                    const openAiChunk = {
                      id: 'chatcmpl-' + Date.now(),
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                    };
                    await writer.write(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`));
                  }
                } catch (e) { /* ignore */ }
              }
            }
          }
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
          // ignore
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const data = await resp.json();
    let text = '';
    if (data?.candidates?.[0]?.content?.parts) {
      text = data.candidates[0].content.parts.map(p => p.text || '').join('');
    }
    const finishReason = data?.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';

    const openAiResponse = {
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
    };

    return new Response(JSON.stringify(openAiResponse), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: { message: `Worker Error: ${err.message}`, type: 'internal_error' },
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
