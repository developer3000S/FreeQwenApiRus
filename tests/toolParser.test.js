import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseToolCallJson } from '../src/api/toolParser.js';

function simplify(calls) {
  return calls.map(call => ({
    name: call.function.name,
    args: JSON.parse(call.function.arguments),
    index: call.index
  }));
}

test('parseToolCallJson accepts JSON fenced in markdown with surrounding prose', () => {
  const calls = parseToolCallJson('I will call the tool.\n```json\n{"tool_calls":[{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}]}\n```');
  assert.deepEqual(simplify(calls), [{ name: 'read_file', args: { path: '/tmp/a.txt' }, index: 0 }]);
});

test('parseToolCallJson accepts OpenAI assistant tool_calls shape', () => {
  const calls = parseToolCallJson(JSON.stringify({
    tool_calls: [{
      id: 'call_fixed',
      type: 'function',
      function: { name: 'terminal', arguments: '{"command":"pwd"}' }
    }]
  }));
  assert.equal(calls[0].id, 'call_fixed');
  assert.deepEqual(simplify(calls), [{ name: 'terminal', args: { command: 'pwd' }, index: 0 }]);
});

test('parseToolCallJson accepts ds2api-style DSML tool wrapper', () => {
  const calls = parseToolCallJson('<|DSML|tool_calls><|DSML|invoke name="write_file"><|DSML|parameter name="path">/tmp/x.txt</|DSML|parameter><|DSML|parameter name="content"><![CDATA[hello]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>');
  assert.deepEqual(simplify(calls), [{ name: 'write_file', args: { path: '/tmp/x.txt', content: 'hello' }, index: 0 }]);
});

test('parseToolCallJson repairs common DSML delimiter drift and smart quotes', () => {
  const calls = parseToolCallJson('<！DSML！tool_calls><！DSML！invoke name=“Bash”><！DSML！parameter name=“command”>echo ok</！DSML！parameter></！DSML！invoke></！DSML！tool_calls>');
  assert.deepEqual(simplify(calls), [{ name: 'Bash', args: { command: 'echo ok' }, index: 0 }]);
});

test('parseToolCallJson accepts legacy XML tool_calls wrapper with JSON parameter values', () => {
  const calls = parseToolCallJson('<tool_calls><invoke name="multi"><parameter name="items">[1,2,3]</parameter><parameter name="opts">{"dryRun":true}</parameter></invoke></tool_calls>');
  assert.deepEqual(simplify(calls), [{ name: 'multi', args: { items: [1, 2, 3], opts: { dryRun: true } }, index: 0 }]);
});

test('parseToolCallJson repairs collapsed DSML local names', () => {
  const calls = parseToolCallJson('<DSMLtool_calls><DSMLinvoke name="terminal"><DSMLparameter name="command">pwd</DSMLparameter></DSMLinvoke></DSMLtool_calls>');
  assert.deepEqual(simplify(calls), [{ name: 'terminal', args: { command: 'pwd' }, index: 0 }]);
});

test('parseToolCallJson repairs PascalCase and arbitrary protocol prefixes', () => {
  const calls = parseToolCallJson('<proto💥ToolCalls><proto💥Invoke name="terminal"><proto💥Parameter name="command">pwd</proto💥Parameter></proto💥Invoke></proto💥ToolCalls>');
  assert.deepEqual(simplify(calls), [{ name: 'terminal', args: { command: 'pwd' }, index: 0 }]);
});

test('parseToolCallJson narrowly repairs missing opening tool wrapper when closing wrapper exists', () => {
  const calls = parseToolCallJson('<invoke name="terminal"><parameter name="command">pwd</parameter></invoke></tool_calls>');
  assert.deepEqual(simplify(calls), [{ name: 'terminal', args: { command: 'pwd' }, index: 0 }]);
});

test('parseToolCallJson returns null for bare invoke outside wrapper', () => {
  assert.equal(parseToolCallJson('<invoke name="terminal"><parameter name="command">pwd</parameter></invoke>'), null);
});

test('parseToolCallJson does not turn malformed complete wrapper into tool call', () => {
  assert.equal(parseToolCallJson('<tool_calls><invoke name="terminal"><parameter name="command">pwd</parameter></tool_calls>'), null);
});
