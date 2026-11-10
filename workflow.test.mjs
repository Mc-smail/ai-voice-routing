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

test('webhook validates transcript before the opening hours and model branches', async () => {
  const webhook = nodes.get('Webhook');
  assert.equal(webhook.parameters.responseMode, 'responseNode');
  assert.equal(workflow.connections.Webhook.main[0][0].node, 'Validate Transcript');
  assert.equal(workflow.connections['Validate Transcript'].main[0][0].node, 'Transcript Valid?');
  const switchRules = nodes.get('Transcript Valid?').parameters.rules.values;
  const branches = workflow.connections['Transcript Valid?'].main;
  assert.deepEqual(switchRules.map(rule => {
    const condition = rule.conditions.conditions[0];
    assert.equal(condition.leftValue, '={{ $json.validTranscript }}');
    return condition.operator.operation;
  }), ['true', 'false']);
  assert.deepEqual(branches.map(branch => branch[0].node), ['Date & Time Berlin', 'Invalid Transcript']);
  assert.equal(branches[1].length, 1);
  const response = nodes.get(branches[1][0].node);
  assert.equal(response.type, 'n8n-nodes-base.respondToWebhook');
  assert.equal(response.parameters.options.responseCode, 400);
  assert.equal(JSON.parse(response.parameters.responseBody).status, 'invalid_request');
  assert.equal(workflow.connections[response.name], undefined);

  for (const body of [{}, {transcript: null}, {transcript: 42}, {transcript: []},
    {transcript: ''}, {transcript: '  \n '}, {transcript: 'a'.repeat(8001)}]) {
    const result = await execute('Validate Transcript', {body, validTranscript: true});
    assert.equal(result.validTranscript, false);
  }
  for (const transcript of ['Ich brauche Hilfe.', '😀'.repeat(4000)]) {
    const result = await execute('Validate Transcript', {body: {transcript}});
    assert.equal(result.validTranscript, true);
    assert.equal(result.body.transcript, transcript);
  }
  assert.equal((await execute('Validate Transcript', {transcript: 'Direkte Eingabe'})).validTranscript, true);
});

test('model instructions stay static while the transcript goes to the user message', () => {
  const {options, responses} = nodes.get('Message a model').parameters;
  assert.equal(typeof options.instructions, 'string');
  assert.doesNotMatch(options.instructions, /\{\{|^=/);
  assert.match(options.instructions, /gültigen JSON-Objekt/);
  assert.deepEqual(responses.values, [
    {type: 'text', role: 'user', content: '={{ $json.transcript }}'},
  ]);
});

test('model failures get a terminal JSON 502 response', () => {
  const model = nodes.get('Message a model');
  assert.equal(model.onError, 'continueErrorOutput');
  const branches = workflow.connections[model.name].main;
  assert.deepEqual(branches.map(branch => branch.map(edge => edge.node)),
    [['Parse AI JSON'], ['Model Unavailable']]);

  const response = nodes.get('Model Unavailable');
  assert.equal(response.type, 'n8n-nodes-base.respondToWebhook');
  assert.equal(response.parameters.respondWith, 'json');
  assert.equal(response.parameters.options.responseCode, 502);
  assert.equal(workflow.connections[response.name], undefined);
  const body = JSON.parse(response.parameters.responseBody);
  assert.deepEqual(Object.keys(body).sort(), ['message', 'status']);
  assert.equal(body.status, 'model_unavailable');
  assert.match(body.message, /später erneut/);
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

for (const expected of [true, false]) {
  test(`webhook fields cannot override the server opening decision (${expected})`, async () => {
    const current_day = expected ? 1 : 0;
    const result = await execute('Check Opening Hours', {
      current_day,
      current_minutes: 600,
      body: {
        forceOpen: !expected,
        isOpen: !expected,
        current_day: expected ? 0 : 1,
        current_minutes: 0,
        transcript: 'Synthetic request',
      },
    });
    assert.equal(result.isOpen, expected);
    assert.equal(result.current_day, current_day);
    assert.equal(result.current_minutes, 600);
    assert.equal(result.transcript, 'Synthetic request');
  });
}

test('opening hours preserves a top-level transcript when the body has none', async () => {
  const result = await execute('Check Opening Hours', {
    current_day: 1, current_minutes: 600, transcript: 'Synthetic request', body: {},
  });
  assert.equal(result.transcript, 'Synthetic request');
});

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

test('model output is normalized to the four supported routing fields', async () => {
  const text = JSON.stringify({
    kategorie: ' VERTRIEB ',
    anliegen: '  ' + '😀'.repeat(501) + '  ',
    prioritaet: ' HOCH ',
    aktion: 'unbekannt',
    transfer_target: 'unbekanntes_ziel',
  });
  const parsed = await execute('Parse AI JSON', {text, provider_metadata: {id: 'fake'}});
  assert.deepEqual(parsed, {
    kategorie: 'vertrieb', anliegen: '😀'.repeat(500), prioritaet: 'hoch', aktion: 'weiterleiten',
  });
});

test('invalid types and missing routing values receive predictable defaults', async () => {
  const expected = {kategorie: 'support', anliegen: '', prioritaet: 'mittel', aktion: 'weiterleiten'};
  assert.deepEqual(await execute('Parse AI JSON', {text: '{}'}), expected);
  assert.deepEqual(await execute('Parse AI JSON', {
    text: JSON.stringify({kategorie: ['vertrieb'], anliegen: {text: 'test'}, prioritaet: 'sofort'}),
  }), expected);
});

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

test('all five routing branches send their configured fields through a shared response', () => {
  const response = nodes.get('Routing Response');
  assert.equal(response.type, 'n8n-nodes-base.respondToWebhook');
  assert.equal(response.parameters.respondWith, 'json');
  const expression = response.parameters.responseBody;
  assert.ok(expression.startsWith('={{') && expression.endsWith('}}'));
  const render = new Function('$json', 'return (' + expression.slice(3, -2) + ');');
  const expectedRoutes = {
    technik: ['Technik Team', 'technik_agent', 'Ich verbinde Sie jetzt mit dem Technik Team.'],
    termin: ['Empfang', 'empfang_agent', 'Ich verbinde Sie jetzt mit unserem Empfang.'],
    bewerbung: ['HR Team', 'hr_agent', 'Ich verbinde Sie jetzt mit unserem HR Team.'],
    vertrieb: ['Sales Team', 'sales_agent', 'Ich verbinde Sie jetzt mit dem Sales Team.'],
    support: ['Support Team', 'support_agent', 'Ich verbinde Sie jetzt mit dem Support Team.'],
  };
  const branches = workflow.connections.Switch.main;
  const rules = nodes.get('Switch').parameters.rules.values;
  const categories = [];
  for (let index = 0; index < branches.length; index++) {
    const category = rules[index].conditions.conditions[0].rightValue;
    categories.push(category);
    const [agent_name, transfer_target, message] = expectedRoutes[category];
    assert.equal(branches[index].length, 1);
    const route = nodes.get(branches[index][0].node);
    assert.deepEqual(workflow.connections[route.name].main[0].map(edge => edge.node), [response.name]);
    const assignments = Object.fromEntries(route.parameters.assignments.assignments.map(item => [item.name, item.value]));
    assert.deepEqual(render({...assignments, extra: 'internal only'}),
      {message, department: category, agent_name, transfer_target});
  }
  assert.deepEqual(categories.sort(), Object.keys(expectedRoutes).sort());
  assert.equal(render({agent_name: 'Geändertes Team'}).agent_name, 'Geändertes Team');
});

test('OpenAPI examples match the exported webhook and response data', async () => {
  const spec = JSON.parse(await readFile(new URL('./docs/webhook.openapi.json', import.meta.url), 'utf8'));
  const path = '/' + nodes.get('Webhook').parameters.path;
  const operation = spec.paths[path].post;
  const request = operation.requestBody.content['application/json'].examples.routerIssue.value;
  assert.equal((await execute('Validate Transcript', {body: request})).validTranscript, true);
  const route = await execute('Parse AI JSON', {}, request.transcript);
  const routingFields = Object.fromEntries(nodes.get('Technik Routing').parameters.assignments.assignments
    .map(({name, value}) => [name, value]));
  const success = operation.responses['200'].content['application/json'].examples;
  assert.equal(route.kategorie, success.routed.value.department);
  assert.deepEqual(routingFields, success.routed.value);

  const afterHours = await execute('Check Opening Hours', {current_day: 1, current_minutes: 1080});
  assert.equal(afterHours.isOpen, false);
  assert.deepEqual(success.closed.value, {
    status: 'closed', message: afterHours.closed_message, opening_hours: afterHours.opening_hours,
  });
  for (const name of ['Invalid Transcript', 'Model Unavailable']) {
    const {options, responseBody} = nodes.get(name).parameters;
    const documented = operation.responses[options.responseCode].content['application/json'].examples.error.value;
    assert.deepEqual(documented, JSON.parse(responseBody));
  }
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


for (const [transcript, expected] of [
  ['Können Sie mir Ihre Rechnung erklären?', 'support'],
  ['Ich möchte etwas bestellen.', 'vertrieb'],
  ['Ich möchte mit einem Mitarbeiter sprechen.', 'support'],
  ['Ich möchte mit HR über eine freie Stelle sprechen.', 'bewerbung'],
  ['Ich möchte zur HR-Abteilung.', 'bewerbung'],
  ['Haben Sie Stellenangebote?', 'bewerbung'],
  ['Wo finde ich Ihre Jobangebote?', 'bewerbung'],
  ['Darf ich mich bei Ihnen bewerben?', 'bewerbung'],
  ['Was bedeutet äHRlich?', 'support'],
]) {
  test(`recruitment keywords respect Unicode word boundaries: ${transcript}`, async () => {
    const parsed = await execute('Parse AI JSON', {text: '{"kategorie":"support"}'}, transcript);
    assert.equal(parsed.kategorie, expected);
  });
}
