// Harness-specific interpretation stays here; unknown harnesses retain raw evidence.
export function codexTelemetry(text) {
  const items = new Map(), usages = [], errors = []; let started = false, completed = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { errors.push(`Invalid JSONL line ${index + 1}`); continue; }
    if (event.type === 'turn.started') started = true;
    if (event.item?.id) items.set(event.item.id, event.item);
    if (event.type === 'turn.completed') { completed = true; if (event.usage) usages.push(event.usage); }
    if (event.type === 'turn.failed' || event.type === 'error') errors.push(event.error?.message ?? event.message ?? event.type);
  }
  const values = [...items.values()], toolTypes = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'];
  let tokens = null;
  if (usages.length && usages.every(u => ['input_tokens', 'cached_input_tokens', 'output_tokens'].every(k => Number.isFinite(u[k]) && u[k] >= 0) && u.cached_input_tokens <= u.input_tokens)) {
    tokens = { input: 0, cachedInput: 0, output: 0 };
    for (const u of usages) { tokens.input += u.input_tokens - u.cached_input_tokens; tokens.cachedInput += u.cached_input_tokens; tokens.output += u.output_tokens; }
  }
  return { started, completed, errors, tokens, tools: values.filter(i => toolTypes.includes(i.type)).length,
    toolDefinition: 'Unique execution/edit/MCP/search JSONL items; shell subcommands are not expanded.',
    bytesRead: null, bytesReadReason: 'Harness does not expose exact delivered instruction bytes.',
    final: values.filter(i => i.type === 'agent_message').at(-1)?.text ?? '' };
}
