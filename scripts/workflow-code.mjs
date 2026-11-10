import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const workflow = JSON.parse(await readFile(
  new URL('../workflows/ai-voice-routing.json', import.meta.url), 'utf8',
));
export const nodes = new Map(workflow.nodes.map(node => [node.name, node]));
export const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Run a code node from the checked-in workflow with local inputs.
export async function execute(name, input = {}, transcript = '', DateClass = Date) {
  const source = nodes.get(name)?.parameters.jsCode;
  assert.equal(typeof source, 'string', `${name} must contain JavaScript`);
  const run = new AsyncFunction('$input', '$node', 'Date', source);
  const result = await run(
    { first: () => ({ json: input }) },
    { Webhook: { json: { body: { transcript } } } },
    DateClass,
  );
  assert.equal(result.length, 1);
  return result[0].json;
}
