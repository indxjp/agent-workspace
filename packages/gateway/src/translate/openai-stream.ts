import { OpenAIStreamTranslator } from './openai-stream-translator.js';
import type { OpenAIEvent } from './openai-stream-values.js';

/** The JSON payload of one SSE frame's `data:` lines; undefined for keep-alives and `[DONE]`. */
function frameData(rawFrame: string): string | undefined {
  const data = rawFrame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  return !data || data === '[DONE]' ? undefined : data;
}

/** Translate Responses API SSE incrementally into the Anthropic Messages event vocabulary. */
export function translateOpenAIStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const translator = new OpenAIStreamTranslator(fallbackModel);
  let buffer = '';

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, output: string): void => {
    if (output) controller.enqueue(encoder.encode(output));
  };

  const consume = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const rawFrame of frames) {
      const data = frameData(rawFrame);
      if (data === undefined) continue;
      emit(controller, translator.translate(JSON.parse(data) as OpenAIEvent));
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        consume(controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) buffer += '\n\n';
        consume(controller);
        emit(controller, translator.unterminatedFrame());
      },
    }),
  );
}
