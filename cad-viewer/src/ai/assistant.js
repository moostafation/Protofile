// AI drawing assistant built on the Claude API. The browser calls the API
// directly with the user's own key (stored only in this browser).
//
// The conversation is append-only: the document context sits in the first
// user turn (prompt-cached), and every assistant turn is appended unchanged,
// thinking blocks included, so follow-up questions reuse the cache.
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 8;

const SYSTEM = `You are the assistant built into ProtoCAD Viewer, a viewer for AutoCAD drawings (DWG/DXF) and PDF documents used by piping, MEP and plant design engineers.

The current document's extracted data is given inside <document> in the first user message: layers with entity counts and linework lengths, block references with counts and attribute values, and all texts. For PDFs it is the extracted text per page. The user may also attach an image of the current view.

How to work:
- Reply in the language the user writes in (Arabic or English). Keep engineering terms (layer names, tags, sizes) exactly as they appear in the drawing.
- Base counts, tags and quantities on the provided data and say when something is not in the data rather than guessing. Linework lengths are sums of all lines/polylines/arcs on a layer in drawing units, which approximate pipe/duct lengths only when that layer holds the routing.
- Use tables for quantities, schedules and bills of materials.
- Use the tools to search the drawing, zoom to and highlight what you are talking about, or show/hide layers when that helps the user see the answer.
- Refer to drawing items as [#id] (the id numbers from the data or tool results) so the user can click them.`;

const TOOLS = [
  {
    name: 'find_in_drawing',
    description: 'Search the open document for text, tags, block names, attribute values or layer names. Returns matching item ids with their text and layer (for PDFs: page numbers). Use this before zooming to something.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to search for, e.g. "V-101" or "PUMP".' } },
      required: ['query'],
    },
  },
  {
    name: 'zoom_to',
    description: 'Zoom the viewer to items and highlight them for the user. For CAD give item_ids; for PDFs give a page number and optionally a text to highlight on it.',
    input_schema: {
      type: 'object',
      properties: {
        item_ids: { type: 'array', items: { type: 'integer' }, description: 'Item ids from the data or from find_in_drawing.' },
        page: { type: 'integer', description: 'PDF page number (PDF documents only).' },
        text: { type: 'string', description: 'Text to highlight on the PDF page.' },
      },
    },
  },
  {
    name: 'set_layers',
    description: 'Change which CAD layers are visible. Use "only" to isolate layers, or "show"/"hide" lists, or reset=true to restore all layers.',
    input_schema: {
      type: 'object',
      properties: {
        only: { type: 'array', items: { type: 'string' } },
        show: { type: 'array', items: { type: 'string' } },
        hide: { type: 'array', items: { type: 'string' } },
        reset: { type: 'boolean' },
      },
    },
  },
  {
    name: 'item_details',
    description: 'Details of CAD items: type, layer, block name, attributes, text, length, and world coordinates of the bounding box.',
    input_schema: {
      type: 'object',
      properties: { item_ids: { type: 'array', items: { type: 'integer' } } },
      required: ['item_ids'],
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

/** Minimal runtime checks for tool inputs (eager input streaming does not validate them server-side). */
function validate(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  const isStrArr = (v) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'));
  const isIntArr = (v) => v === undefined || (Array.isArray(v) && v.every((n) => Number.isInteger(n)));
  switch (name) {
    case 'find_in_drawing':
      return typeof input.query === 'string' && input.query.trim() ? null : 'query must be a non-empty string';
    case 'zoom_to':
      if (!isIntArr(input.item_ids)) return 'item_ids must be integers';
      if (input.page !== undefined && !Number.isInteger(input.page)) return 'page must be an integer';
      if (input.text !== undefined && typeof input.text !== 'string') return 'text must be a string';
      return null;
    case 'set_layers':
      return isStrArr(input.only) && isStrArr(input.show) && isStrArr(input.hide) && (input.reset === undefined || typeof input.reset === 'boolean') ? null : 'layer lists must be arrays of strings';
    case 'item_details':
      return Array.isArray(input.item_ids) && isIntArr(input.item_ids) ? null : 'item_ids must be an array of integers';
    default:
      return `unknown tool ${name}`;
  }
}

export class Assistant {
  /**
   * @param host {
   *   getDocument(): Promise<{ key, title, text }>,   // data for <document>
   *   captureView(): string,                          // PNG data URL of the current view
   *   tools: { find_in_drawing, zoom_to, set_layers, item_details } // async (input) => result
   * }
   */
  constructor(host) {
    this.host = host;
    this.messages = [];
    this.docKey = null;
    this.busy = false;
    this.abort = null;
  }

  get settings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('protocad.ai') || '{}'); } catch { /* storage unavailable */ }
    return { apiKey: s.apiKey || '', model: s.model || DEFAULT_MODEL, effort: s.effort || 'medium' };
  }

  saveSettings(s) {
    try { localStorage.setItem('protocad.ai', JSON.stringify(s)); } catch { /* storage unavailable */ }
  }

  reset() {
    this.messages = [];
    this.docKey = null;
  }

  stop() {
    this.abort?.abort();
  }

  /**
   * Sends a user message and streams the answer.
   * @param {string} text
   * @param {{ includeView: boolean }} opts
   * @param {(ev) => void} onEvent events: {type:'text', text} {type:'tool', name, input, result} {type:'thinking'} {type:'done'} {type:'error', message}
   */
  async send(text, opts, onEvent) {
    const { apiKey, model, effort } = this.settings;
    if (!apiKey) {
      onEvent({ type: 'error', code: 'no-key' });
      return;
    }
    if (this.busy) return;
    this.busy = true;
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    this.abort = new AbortController();
    let turnStart = this.messages.length;
    try {
      const doc = await this.host.getDocument();
      if (doc.key !== this.docKey) {
        // A different document starts a new conversation.
        this.messages = [];
        this.docKey = doc.key;
        turnStart = 0;
      }
      const content = [];
      if (!this.messages.length) {
        content.push({ type: 'text', text: `<document title="${escapeAttr(doc.title)}">\n${doc.text}\n</document>` });
      }
      if (opts.includeView) {
        const url = this.host.captureView();
        const data = url.slice(url.indexOf(',') + 1);
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
        content.push({ type: 'text', text: '(Attached: image of what is currently visible in the viewer.)' });
      }
      content.push({ type: 'text', text });
      this.messages.push({ role: 'user', content });

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 64000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          output_config: { effort },
          cache_control: { type: 'ephemeral' },
          system: SYSTEM,
          tools: TOOLS,
          messages: this.messages,
        }, { signal: this.abort.signal });

        let message;
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_start' && event.content_block.type === 'thinking') onEvent({ type: 'thinking' });
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onEvent({ type: 'text', text: event.delta.text });
          }
          message = await stream.finalMessage();
        } catch (err) {
          // Tool input that cannot be parsed at all surfaces here as a plain Error; retry the round once.
          if (err instanceof Anthropic.APIError || err?.name === 'AbortError' || this.abort.signal.aborted) throw err;
          if (round === MAX_TOOL_ROUNDS - 1) throw err;
          continue;
        }

        this.messages.push({ role: 'assistant', content: message.content });
        if (message.stop_reason === 'refusal') {
          onEvent({ type: 'error', code: 'refusal' });
          break;
        }
        const toolUses = message.content.filter((b) => b.type === 'tool_use');
        if (message.stop_reason === 'max_tokens' && toolUses.length) {
          onEvent({ type: 'error', code: 'max-tokens' });
          break;
        }
        if (message.stop_reason !== 'tool_use' || !toolUses.length) break;

        const results = [];
        for (const tu of toolUses) {
          const problem = validate(tu.name, tu.input);
          if (problem) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: problem, received: tu.input }) });
            continue;
          }
          try {
            const result = await this.host.tools[tu.name](tu.input);
            onEvent({ type: 'tool', name: tu.name, input: tu.input, result });
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
          } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: String(err?.message || err) });
          }
        }
        // All results of one turn go back in a single user message.
        this.messages.push({ role: 'user', content: results });
        onEvent({ type: 'text', text: '\n\n' });
      }
      onEvent({ type: 'done' });
    } catch (err) {
      onEvent({ type: 'error', code: errorCode(err), message: err?.message });
      // Remove the unfinished turn (it may end in an unanswered tool call) so the next question starts cleanly.
      this.messages.length = turnStart;
      if (!this.messages.length) this.docKey = null;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }
}

function errorCode(err) {
  if (err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (err instanceof Anthropic.AuthenticationError) return 'auth';
  if (err instanceof Anthropic.PermissionDeniedError) return 'permission';
  if (err instanceof Anthropic.NotFoundError) return 'model';
  if (err instanceof Anthropic.RateLimitError) return 'rate';
  if (err instanceof Anthropic.BadRequestError) return 'bad-request';
  if (err instanceof Anthropic.APIConnectionError) return 'network';
  if (err instanceof Anthropic.APIError) return 'api';
  return 'unknown';
}

function escapeAttr(s) {
  return String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
}
