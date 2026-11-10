import { execute, nodes, workflow } from './workflow-code.mjs';

async function runExample({ transcript, at, modelCategory }) {
  const input = { body: { transcript } };
  const checked = await execute('Validate Transcript', input);
  if (!checked.validTranscript) {
    const response = nodes.get('Invalid Transcript').parameters;
    return { statusCode: response.options.responseCode, body: JSON.parse(response.responseBody) };
  }

  class ExampleClock extends Date {
    constructor() { super(at); }
  }
  const clock = await execute('Date & Time Berlin', checked, transcript, ExampleClock);
  const hours = await execute('Check Opening Hours', clock, transcript);
  if (!hours.isOpen) {
    return {
      statusCode: 200,
      body: { message: hours.closed_message, status: 'closed', opening_hours: hours.opening_hours },
    };
  }

  const modelAnswer = { text: JSON.stringify({ kategorie: modelCategory }) };
  const { kategorie } = await execute('Parse AI JSON', modelAnswer, transcript);
  const rules = nodes.get('Switch').parameters.rules.values;
  const index = rules.findIndex(rule => rule.conditions.conditions[0].rightValue === kategorie);
  const route = workflow.connections.Switch.main[index][0].node;
  const assignments = nodes.get(route).parameters.assignments.assignments;
  const body = Object.fromEntries(assignments.map(({ name, value }) => [name, value]));
  return { statusCode: 200, body };
}

const mondayMorning = '2026-11-09T09:00:00Z';
const examples = [
  { transcript: 'Mein Router funktioniert nicht.', at: mondayMorning, modelCategory: 'support' },
  { transcript: 'Können wir über die Konditionen sprechen?', at: mondayMorning, modelCategory: 'vertrieb' },
  { transcript: 'Ich möchte einen Termin.', at: '2026-11-09T19:00:00Z' },
  { transcript: '   ', at: mondayMorning },
];

const results = [];
for (const example of examples) {
  results.push({ transcript: example.transcript, at: example.at, ...await runExample(example) });
}
console.log(JSON.stringify(results, null, 2));
