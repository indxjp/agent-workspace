type OpenAIEvent = Record<string, unknown>;

type TextBlock = {
  readonly kind: 'text';
  readonly index: number;
  closed: boolean;
  text: string;
};

type ToolBlock = {
  readonly kind: 'tool';
  readonly index: number;
  closed: boolean;
  arguments: string;
};

type ContentBlock = TextBlock | ToolBlock;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function responseContainsFunctionCall(response: Record<string, unknown>): boolean {
  return (
    Array.isArray(response['output']) &&
    response['output'].some((item) => record(item)['type'] === 'function_call')
  );
}

/** Translate Responses API SSE incrementally into the Anthropic Messages event vocabulary. */
export function translateOpenAIStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let responseId = `msg_${crypto.randomUUID()}`;
  let model = fallbackModel;
  let nextBlockIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawToolUse = false;
  let terminal = false;
  const blocks: ContentBlock[] = [];
  const textBlocks = new Map<string, TextBlock>();
  const toolBlocksByItemId = new Map<string, ToolBlock>();
  const toolBlocksByOutputIndex = new Map<number, ToolBlock>();

  const textKey = (event: OpenAIEvent): string => {
    const itemId = stringValue(event['item_id']);
    const outputIndex = integerValue(event['output_index']);
    const contentIndex = integerValue(event['content_index']) ?? 0;
    if (itemId) return `item:${itemId}:${String(contentIndex)}`;
    if (outputIndex !== undefined) return `output:${String(outputIndex)}:${String(contentIndex)}`;
    return `default:${String(contentIndex)}`;
  };

  const startText = (
    event: OpenAIEvent,
  ): { readonly block: TextBlock; readonly output: string } => {
    const key = textKey(event);
    const existing = textBlocks.get(key);
    if (existing !== undefined) return { block: existing, output: '' };
    const block: TextBlock = { kind: 'text', index: nextBlockIndex, closed: false, text: '' };
    nextBlockIndex += 1;
    blocks.push(block);
    textBlocks.set(key, block);
    return {
      block,
      output: frame('content_block_start', {
        type: 'content_block_start',
        index: block.index,
        content_block: { type: 'text', text: '' },
      }),
    };
  };

  const appendText = (block: TextBlock, text: string): string => {
    if (block.closed || text.length === 0) return '';
    block.text += text;
    return frame('content_block_delta', {
      type: 'content_block_delta',
      index: block.index,
      delta: { type: 'text_delta', text },
    });
  };

  const stopBlock = (block: ContentBlock): string => {
    if (block.closed) return '';
    block.closed = true;
    return frame('content_block_stop', { type: 'content_block_stop', index: block.index });
  };

  const toolBlock = (event: OpenAIEvent): ToolBlock | undefined => {
    const itemId = stringValue(event['item_id']);
    if (itemId) {
      const byId = toolBlocksByItemId.get(itemId);
      if (byId !== undefined) return byId;
    }
    const outputIndex = integerValue(event['output_index']);
    return outputIndex === undefined ? undefined : toolBlocksByOutputIndex.get(outputIndex);
  };

  const startTool = (
    event: OpenAIEvent,
    item: Record<string, unknown>,
  ): { readonly block: ToolBlock; readonly output: string } => {
    const itemId = stringValue(item['id'], stringValue(event['item_id']));
    const outputIndex = integerValue(event['output_index']);
    const existing =
      (itemId ? toolBlocksByItemId.get(itemId) : undefined) ??
      (outputIndex === undefined ? undefined : toolBlocksByOutputIndex.get(outputIndex));
    if (existing !== undefined) return { block: existing, output: '' };

    const callId = stringValue(item['call_id'], stringValue(event['call_id'], itemId));
    const block: ToolBlock = { kind: 'tool', index: nextBlockIndex, closed: false, arguments: '' };
    nextBlockIndex += 1;
    sawToolUse = true;
    blocks.push(block);
    if (itemId) toolBlocksByItemId.set(itemId, block);
    if (outputIndex !== undefined) toolBlocksByOutputIndex.set(outputIndex, block);
    return {
      block,
      output: frame('content_block_start', {
        type: 'content_block_start',
        index: block.index,
        content_block: {
          type: 'tool_use',
          id: callId,
          name: stringValue(item['name'], stringValue(event['name'])),
          input: {},
        },
      }),
    };
  };

  const appendToolArguments = (block: ToolBlock, delta: string): string => {
    if (block.closed || delta.length === 0) return '';
    block.arguments += delta;
    return frame('content_block_delta', {
      type: 'content_block_delta',
      index: block.index,
      delta: { type: 'input_json_delta', partial_json: delta },
    });
  };

  const finishToolArguments = (block: ToolBlock, finalArguments: string): string => {
    if (finalArguments.length === 0 || finalArguments === block.arguments) return '';
    // A well-formed provider repeats the concatenated deltas in the done event. Some compatible
    // endpoints emit only the done event; append the missing suffix so those calls remain usable.
    if (finalArguments.startsWith(block.arguments)) {
      return appendToolArguments(block, finalArguments.slice(block.arguments.length));
    }
    return '';
  };

  const closeOpenBlocks = (): string => blocks.map((block) => stopBlock(block)).join('');

  const terminalFrames = (event: OpenAIEvent): string => {
    if (terminal) return '';
    terminal = true;
    const response = record(event['response']);
    const usage = record(response['usage']);
    inputTokens = Number(usage['input_tokens'] ?? 0);
    outputTokens = Number(usage['output_tokens'] ?? 0);
    const incomplete = record(response['incomplete_details']);
    const stoppedAtLimit = incomplete['reason'] === 'max_output_tokens';
    const stopReason = stoppedAtLimit
      ? 'max_tokens'
      : sawToolUse || responseContainsFunctionCall(response)
        ? 'tool_use'
        : 'end_turn';
    return `${closeOpenBlocks()}${frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    })}${frame('message_stop', { type: 'message_stop' })}`;
  };

  const translate = (event: OpenAIEvent): string => {
    const type = stringValue(event['type']);
    if (type === 'response.created') {
      const response = record(event['response']);
      responseId = stringValue(response['id'], responseId);
      model = stringValue(response['model'], model);
      return frame('message_start', {
        type: 'message_start',
        message: {
          id: responseId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    if (type === 'response.content_part.added') {
      const part = record(event['part']);
      return part['type'] === 'output_text' ? startText(event).output : '';
    }
    if (type === 'response.output_text.delta') {
      const started = startText(event);
      return `${started.output}${appendText(started.block, stringValue(event['delta']))}`;
    }
    if (type === 'response.output_text.done' || type === 'response.content_part.done') {
      const part = record(event['part']);
      if (type === 'response.content_part.done' && part['type'] !== 'output_text') return '';
      const started = startText(event);
      const finalText = stringValue(
        type === 'response.output_text.done' ? event['text'] : part['text'],
      );
      const suffix = finalText.startsWith(started.block.text)
        ? finalText.slice(started.block.text.length)
        : '';
      return `${started.output}${appendText(started.block, suffix)}${stopBlock(started.block)}`;
    }
    if (type === 'response.output_item.added') {
      const item = record(event['item']);
      return item['type'] === 'function_call' ? startTool(event, item).output : '';
    }
    if (type === 'response.function_call_arguments.delta') {
      const block = toolBlock(event);
      return block === undefined ? '' : appendToolArguments(block, stringValue(event['delta']));
    }
    if (type === 'response.function_call_arguments.done') {
      const existing = toolBlock(event);
      const started =
        existing === undefined
          ? startTool(event, {
              id: event['item_id'],
              call_id: event['call_id'],
              name: event['name'],
            })
          : { block: existing, output: '' };
      return `${started.output}${finishToolArguments(
        started.block,
        stringValue(event['arguments']),
      )}`;
    }
    if (type === 'response.output_item.done') {
      const item = record(event['item']);
      if (item['type'] !== 'function_call') return '';
      const existing = toolBlock({ ...event, item_id: item['id'] ?? event['item_id'] });
      const started =
        existing === undefined ? startTool(event, item) : { block: existing, output: '' };
      return `${started.output}${finishToolArguments(
        started.block,
        stringValue(item['arguments']),
      )}${stopBlock(started.block)}`;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      return terminalFrames(event);
    }
    if (type === 'response.failed' || type === 'error') {
      terminal = true;
      const response = record(event['response']);
      const error = record(response['error']);
      return frame('error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: stringValue(
            event['message'],
            stringValue(error['message'], 'OpenAI stream failed'),
          ),
        },
      });
    }
    return '';
  };

  const consume = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const rawFrame of frames) {
      const data = rawFrame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      const output = translate(JSON.parse(data) as OpenAIEvent);
      if (output) controller.enqueue(encoder.encode(output));
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
      },
    }),
  );
}
