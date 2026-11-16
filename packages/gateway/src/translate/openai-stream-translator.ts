import {
  frame,
  integerValue,
  record,
  responseContainsFunctionCall,
  stringValue,
  streamUsage,
  type OpenAIEvent,
} from './openai-stream-values.js';

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

/** A block together with the `content_block_start` frame emitted when it was first opened. */
type Started<Block> = { readonly block: Block; readonly output: string };

const UNTERMINATED_STREAM_MESSAGE = 'OpenAI stream ended without a terminal event';

function unopened<Block>(block: Block): Started<Block> {
  return { block, output: '' };
}

/**
 * Stateful translation of one Responses API event stream into Anthropic Messages SSE frames.
 * Every `on*` handler returns the frames (possibly none) to emit for its event.
 */
export class OpenAIStreamTranslator {
  private responseId = `msg_${crypto.randomUUID()}`;
  private model: string;
  private nextBlockIndex = 0;
  private sawToolUse = false;
  private terminal = false;
  private started = false;
  private readonly blocks: ContentBlock[] = [];
  private readonly textBlocks = new Map<string, TextBlock>();
  private readonly toolBlocksByItemId = new Map<string, ToolBlock>();
  private readonly toolBlocksByOutputIndex = new Map<number, ToolBlock>();

  constructor(fallbackModel: string) {
    this.model = fallbackModel;
  }

  /** Frames for one decoded upstream event; the empty string when the event has no counterpart. */
  translate(event: OpenAIEvent): string {
    const type = stringValue(event['type']);
    switch (type) {
      case 'response.created':
        return this.onCreated(event);
      case 'response.content_part.added':
        return record(event['part'])['type'] === 'output_text' ? this.startText(event).output : '';
      case 'response.output_text.delta':
        return this.onTextDelta(event);
      case 'response.output_text.done':
        return this.onTextDone(event, stringValue(event['text']));
      case 'response.content_part.done':
        return this.onContentPartDone(event);
      case 'response.output_item.added':
        return this.onItemAdded(event);
      case 'response.function_call_arguments.delta':
        return this.onArgumentsDelta(event);
      case 'response.function_call_arguments.done':
        return this.onArgumentsDone(event);
      case 'response.output_item.done':
        return this.onItemDone(event);
      case 'response.completed':
      case 'response.incomplete':
        return this.terminalFrames(event);
      case 'response.failed':
      case 'error':
        return this.onFailed(event);
      default:
        return '';
    }
  }

  /**
   * The closing frame when the upstream ended without a terminal event: the turn is incomplete,
   * never a clean end, and carries no usage, so the meter cannot settle it as measured zero.
   */
  unterminatedFrame(): string {
    if (!this.started || this.terminal) return '';
    this.terminal = true;
    return frame('error', {
      type: 'error',
      error: { type: 'api_error', message: UNTERMINATED_STREAM_MESSAGE },
    });
  }

  private onCreated(event: OpenAIEvent): string {
    const response = record(event['response']);
    this.responseId = stringValue(response['id'], this.responseId);
    this.model = stringValue(response['model'], this.model);
    this.started = true;
    return frame('message_start', {
      type: 'message_start',
      message: {
        id: this.responseId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private onTextDelta(event: OpenAIEvent): string {
    const opened = this.startText(event);
    return `${opened.output}${this.appendText(opened.block, stringValue(event['delta']))}`;
  }

  private onContentPartDone(event: OpenAIEvent): string {
    const part = record(event['part']);
    if (part['type'] !== 'output_text') return '';
    return this.onTextDone(event, stringValue(part['text']));
  }

  private onTextDone(event: OpenAIEvent, finalText: string): string {
    const opened = this.startText(event);
    const suffix = finalText.startsWith(opened.block.text)
      ? finalText.slice(opened.block.text.length)
      : '';
    return `${opened.output}${this.appendText(opened.block, suffix)}${this.stopBlock(opened.block)}`;
  }

  private onItemAdded(event: OpenAIEvent): string {
    const item = record(event['item']);
    return item['type'] === 'function_call' ? this.startTool(event, item).output : '';
  }

  private onArgumentsDelta(event: OpenAIEvent): string {
    const block = this.findToolBlock(event);
    return block === undefined ? '' : this.appendToolArguments(block, stringValue(event['delta']));
  }

  private onArgumentsDone(event: OpenAIEvent): string {
    const existing = this.findToolBlock(event);
    const opened =
      existing === undefined
        ? this.startTool(event, {
            id: event['item_id'],
            call_id: event['call_id'],
            name: event['name'],
          })
        : unopened(existing);
    return `${opened.output}${this.finishToolArguments(
      opened.block,
      stringValue(event['arguments']),
    )}`;
  }

  private onItemDone(event: OpenAIEvent): string {
    const item = record(event['item']);
    if (item['type'] !== 'function_call') return '';
    const existing = this.findToolBlock({ ...event, item_id: item['id'] ?? event['item_id'] });
    const opened = existing === undefined ? this.startTool(event, item) : unopened(existing);
    return `${opened.output}${this.finishToolArguments(
      opened.block,
      stringValue(item['arguments']),
    )}${this.stopBlock(opened.block)}`;
  }

  private onFailed(event: OpenAIEvent): string {
    this.terminal = true;
    const response = record(event['response']);
    const error = record(response['error']);
    const failedUsage = record(response['usage']);
    return frame('error', {
      type: 'error',
      // Tokens the upstream already spent before failing are still billable; the meter reads
      // `usage` from any frame, and an absent one stays "unmeasured" rather than $0.
      ...(Object.keys(failedUsage).length === 0 ? {} : { usage: streamUsage(failedUsage) }),
      error: {
        type: 'api_error',
        message: stringValue(
          event['message'],
          stringValue(error['message'], 'OpenAI stream failed'),
        ),
      },
    });
  }

  private terminalFrames(event: OpenAIEvent): string {
    if (this.terminal) return '';
    this.terminal = true;
    const response = record(event['response']);
    const closing = this.blocks.map((block) => this.stopBlock(block)).join('');
    return `${closing}${frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason(response), stop_sequence: null },
      usage: streamUsage(record(response['usage'])),
    })}${frame('message_stop', { type: 'message_stop' })}`;
  }

  private stopReason(response: Record<string, unknown>): 'max_tokens' | 'tool_use' | 'end_turn' {
    if (record(response['incomplete_details'])['reason'] === 'max_output_tokens') {
      return 'max_tokens';
    }
    return this.sawToolUse || responseContainsFunctionCall(response) ? 'tool_use' : 'end_turn';
  }

  private textKey(event: OpenAIEvent): string {
    const itemId = stringValue(event['item_id']);
    const outputIndex = integerValue(event['output_index']);
    const contentIndex = integerValue(event['content_index']) ?? 0;
    if (itemId) return `item:${itemId}:${String(contentIndex)}`;
    if (outputIndex !== undefined) return `output:${String(outputIndex)}:${String(contentIndex)}`;
    return `default:${String(contentIndex)}`;
  }

  private startText(event: OpenAIEvent): Started<TextBlock> {
    const key = this.textKey(event);
    const existing = this.textBlocks.get(key);
    if (existing !== undefined) return unopened(existing);
    const block: TextBlock = { kind: 'text', index: this.nextBlockIndex, closed: false, text: '' };
    this.nextBlockIndex += 1;
    this.blocks.push(block);
    this.textBlocks.set(key, block);
    return {
      block,
      output: frame('content_block_start', {
        type: 'content_block_start',
        index: block.index,
        content_block: { type: 'text', text: '' },
      }),
    };
  }

  private appendText(block: TextBlock, text: string): string {
    if (block.closed || text.length === 0) return '';
    block.text += text;
    return frame('content_block_delta', {
      type: 'content_block_delta',
      index: block.index,
      delta: { type: 'text_delta', text },
    });
  }

  private stopBlock(block: ContentBlock): string {
    if (block.closed) return '';
    block.closed = true;
    return frame('content_block_stop', { type: 'content_block_stop', index: block.index });
  }

  private findToolBlock(event: OpenAIEvent): ToolBlock | undefined {
    const itemId = stringValue(event['item_id']);
    if (itemId) {
      const byId = this.toolBlocksByItemId.get(itemId);
      if (byId !== undefined) return byId;
    }
    const outputIndex = integerValue(event['output_index']);
    return outputIndex === undefined ? undefined : this.toolBlocksByOutputIndex.get(outputIndex);
  }

  private startTool(event: OpenAIEvent, item: Record<string, unknown>): Started<ToolBlock> {
    const itemId = stringValue(item['id'], stringValue(event['item_id']));
    const outputIndex = integerValue(event['output_index']);
    const existing =
      (itemId ? this.toolBlocksByItemId.get(itemId) : undefined) ??
      (outputIndex === undefined ? undefined : this.toolBlocksByOutputIndex.get(outputIndex));
    if (existing !== undefined) return unopened(existing);

    const callId = stringValue(item['call_id'], stringValue(event['call_id'], itemId));
    const block: ToolBlock = {
      kind: 'tool',
      index: this.nextBlockIndex,
      closed: false,
      arguments: '',
    };
    this.nextBlockIndex += 1;
    this.sawToolUse = true;
    this.blocks.push(block);
    if (itemId) this.toolBlocksByItemId.set(itemId, block);
    if (outputIndex !== undefined) this.toolBlocksByOutputIndex.set(outputIndex, block);
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
  }

  private appendToolArguments(block: ToolBlock, delta: string): string {
    if (block.closed || delta.length === 0) return '';
    block.arguments += delta;
    return frame('content_block_delta', {
      type: 'content_block_delta',
      index: block.index,
      delta: { type: 'input_json_delta', partial_json: delta },
    });
  }

  private finishToolArguments(block: ToolBlock, finalArguments: string): string {
    if (finalArguments.length === 0 || finalArguments === block.arguments) return '';
    // A well-formed provider repeats the concatenated deltas in the done event. Some compatible
    // endpoints emit only the done event; append the missing suffix so those calls remain usable.
    if (finalArguments.startsWith(block.arguments)) {
      return this.appendToolArguments(block, finalArguments.slice(block.arguments.length));
    }
    return '';
  }
}
