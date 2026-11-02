// Shared model call: works with the WebView client and the injected task client.
export async function ask(client, messages, { signal, onText } = {}) {
  if (signal?.aborted) throw new Error('已停止生成');
  if (onText) {
    const stream = client.chat.completions.stream({ messages, signal });
    stream.on('content', (_delta, snapshot) => onText(snapshot));
    stream.on('error', () => {});
    return await stream.finalContent();
  }
  const result = await client.chat.completions.create({ messages, ...(signal ? { signal } : {}) });
  const text = result?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回内容');
  return text;
}
