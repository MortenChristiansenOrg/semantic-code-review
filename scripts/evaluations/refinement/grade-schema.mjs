const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) });
const choice = values => ({ type: 'string', enum: values });
const array = items => ({ type: 'array', items });
export const subjectiveScale = Object.freeze({ minimum: 1, maximum: 10, neutral: 6, version: 'ten-level-v1' });
const score = object({ score: { anyOf: [integer(1, subjectiveScale.maximum), { type: 'null' }] }, reason: string });

export function gradeSchema(packet) {
  const calibration = object({ mechanicsStop: integer(0), productQuestion: integer(0), stageOnlyTraceability: integer(1, subjectiveScale.maximum), ambiguousClarity: integer(1, subjectiveScale.maximum), neutralMaintainability: integer(1, subjectiveScale.maximum), routineInsightPolicy: { type: 'boolean' }, missingSignificantInsightPolicy: { type: 'boolean' } });
  if (packet.kind === 'instructions') return object({
    calibration,
    documents: array(object({ label: choice(packet.labels), path: choice([...new Set(packet.documents.map(d => d.path))]), clarity: integer(1, subjectiveScale.maximum), reason: string })),
    consistency: array(object({ label: choice(packet.labels), findings: array(object({ severity: choice(['minor', 'material', 'blocking']), files: array(string), explanation: string })) })),
    maintainability: { ...array(object({ from: choice(packet.labels), to: choice(packet.labels), score: integer(1, subjectiveScale.maximum), reason: string })), ...(packet.labels.length === 1 ? { maxItems: 0 } : {}) },
  });
  return object({ calibration, runs: array({ anyOf: packet.runs.map(run => object({
    id: choice([run.id]),
    // The allowed IDs come solely from transcriptChecks, never the supplied deterministic evidence.
    checks: array(object({ id: choice(run.transcriptChecks), passed: { type: 'boolean' }, evidence: string })),
    violations: array(object({ id: string, attribution: choice(['agent', 'infrastructure', 'uncertain']), evidence: string })),
    cliRejected: integer(0), cliUnrecovered: integer(0), prompts: integer(0), countEvidence: string,
    subjective: object(Object.fromEntries(['organization', 'insights', 'traceability', 'readability', 'responses', 'followability'].map(name => [name, score]))),
  })) }) });
}
