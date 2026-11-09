import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = JSON.parse(await readFile(new URL('./workflows/ai-voice-routing.json', import.meta.url), 'utf8'));
const nodes = new Map(workflow.nodes.map(node => [node.name, node]));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Only synthetic node inputs are supplied. No n8n instance or external API is used.
async function execute(name, input = {}, transcript = '', DateClass = Date) {
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

test('export has unique nodes and connections refer to existing nodes', () => {
  assert.equal(nodes.size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map(node => node.id)).size, workflow.nodes.length);
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert.ok(nodes.has(source), `unknown connection source: ${source}`);
    for (const branches of Object.values(outputs)) {
      for (const branch of branches) {
        for (const destination of branch) {
          assert.ok(nodes.has(destination.node), `unknown destination: ${destination.node}`);
          assert.equal(destination.type, 'main');
          assert.equal(destination.index, 0);
        }
      }
    }
  }
});

test('public export has no credentials, pinned data or active workflow', () => {
  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.pinData, {});
  for (const node of workflow.nodes) {
    assert.ok(!Object.hasOwn(node, 'credentials'), `${node.name} exports credentials`);
  }
  assert.doesNotMatch(JSON.stringify(workflow), /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/);
});

test('all code nodes compile without executing their code', () => {
  for (const node of workflow.nodes.filter(node => node.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new AsyncFunction('$input', '$node', 'Date', node.parameters.jsCode), node.name);
  }
});

for (const [label, current_day, current_minutes, expected] of [
  ['weekday before 09:00', 1, 539, false],
  ['weekday at 09:00', 1, 540, true],
  ['Friday before 18:00', 5, 1079, true],
  ['weekday at 18:00', 3, 1080, false],
  ['Saturday', 6, 720, false],
  ['Sunday', 0, 720, false],
]) {
  test(`opening hours: ${label}`, async () => {
    assert.equal((await execute('Check Opening Hours', { current_day, current_minutes })).isOpen, expected);
  });
}

for (const forceOpen of [true, false]) {
  test(`explicit test override forceOpen=${forceOpen}`, async () => {
    const result = await execute('Check Opening Hours', {
      current_day: forceOpen ? 0 : 1,
      current_minutes: forceOpen ? 0 : 600,
      body: { forceOpen, transcript: 'Synthetic request' },
    });
    assert.equal(result.isOpen, forceOpen);
    assert.equal(result.transcript, 'Synthetic request');
  });
}

for (const [label, timestamp, expectedHour, expectedDay] of [
  ['winter UTC+1', '2026-01-12T08:30:00.000Z', 9, 1],
  ['summer UTC+2', '2026-07-13T07:30:00.000Z', 9, 1],
  ['Berlin date rollover', '2026-01-11T23:30:00.000Z', 0, 1],
]) {
  test(`Berlin clock: ${label}`, async () => {
    class FixedDate extends Date {
      constructor(...args) { super(...(args.length ? args : [timestamp])); }
    }
    const result = await execute('Date & Time Berlin', { marker: 'retained' }, '', FixedDate);
    assert.equal(result.current_datetime_utc, timestamp);
    assert.equal(result.current_hour, expectedHour);
    assert.equal(result.current_minute, 30);
    assert.equal(result.current_minutes, expectedHour * 60 + 30);
    assert.equal(result.current_day, expectedDay);
    assert.equal(result.timezone, 'Europe/Berlin');
    assert.equal(result.marker, 'retained');
  });
}

const aiObject = { kategorie: 'vertrieb', anliegen: 'Synthetic request', prioritaet: 'mittel', aktion: 'weiterleiten' };
for (const [label, input] of [
  ['direct object', aiObject],
  ['nested response content', { output: [{ content: [{ text: JSON.stringify(aiObject) }] }] }],
  ['output_text', { output_text: JSON.stringify(aiObject) }],
  ['preamble and fenced JSON', { text: `Hier ist das Ergebnis:\n\`\`\`json\n${JSON.stringify(aiObject)}\n\`\`\`` }],
]) {
  test(`AI JSON parser: ${label}`, async () => {
    const parsed = await execute('Parse AI JSON', input);
    for (const [key, value] of Object.entries(aiObject)) assert.equal(parsed[key], value);
  });
}

for (const input of [{ text: 'broken { invalid JSON' }, { text: 'null' }, { text: '[]' }, { text: '{"kategorie":"unknown"}' }]) {
  test(`malformed or unsupported AI answer falls back to support: ${JSON.stringify(input)}`, async () => {
    assert.equal((await execute('Parse AI JSON', input)).kategorie, 'support');
  });
}

for (const [transcript, expected] of [
  ['Mein Router hat einen Fehler.', 'technik'],
  ['Ich möchte einen Termin wegen eines technischen Problems.', 'termin'],
  ['Ich schicke eine Bewerbung mit Lebenslauf.', 'bewerbung'],
  ['Ich möchte ein Angebot und einen Preis.', 'vertrieb'],
  ['Ich möchte eine Reklamation melden.', 'support'],
]) {
  test(`keyword routing: ${expected}`, async () => {
    const parsed = await execute('Parse AI JSON', { text: '{"kategorie":"support"}' }, transcript);
    assert.equal(parsed.kategorie, expected);
  });
}

test('all five switch branches and response payloads agree with their routing assignments', () => {
  const switchNode = nodes.get('Switch');
  const branches = workflow.connections.Switch.main;
  assert.equal(branches.length, 5);
  const departments = new Set();
  for (let index = 0; index < branches.length; index++) {
    const category = switchNode.parameters.rules.values[index].conditions.conditions[0].rightValue;
    departments.add(category);
    assert.equal(branches[index].length, 1);
    const routing = nodes.get(branches[index][0].node);
    const assignments = Object.fromEntries(routing.parameters.assignments.assignments.map(item => [item.name, item.value]));
    assert.equal(assignments.department, category);
    const responseEdges = workflow.connections[routing.name].main[0];
    assert.equal(responseEdges.length, 1);
    const response = nodes.get(responseEdges[0].node);
    assert.equal(response.type, 'n8n-nodes-base.respondToWebhook');
    assert.equal(response.parameters.respondWith, 'json');
    const payload = JSON.parse(response.parameters.responseBody.replace(/^=/, ''));
    assert.equal(payload.department, assignments.department);
    assert.equal(payload.transfer_target, assignments.transfer_target);
    assert.equal(payload.agent_name.toLowerCase(), assignments.agent_name.toLowerCase());
    assert.equal(typeof payload.message, 'string');
    assert.ok(payload.message.length > 0);
  }
  assert.deepEqual([...departments].sort(), ['bewerbung', 'support', 'technik', 'termin', 'vertrieb']);
});


test('JSON recovery ignores unrelated trailing objects and braces inside quoted values', async () => {
  const result = {...aiObject, anliegen: 'Text with {braces} and "quotes"'};
  const text = 'Ergebnis: ' + JSON.stringify(result) + ' Zusatz: {"info":"kein Routing"}';
  const parsed = await execute('Parse AI JSON', {text});
  assert.equal(parsed.kategorie, 'vertrieb');
  assert.equal(parsed.anliegen, result.anliegen);
});

test('two distinct routing objects are ambiguous and fall back to support', async () => {
  const text = JSON.stringify(aiObject) + '\n' + JSON.stringify({...aiObject, kategorie:'technik'});
  assert.equal((await execute('Parse AI JSON', {text})).kategorie, 'support');
});
