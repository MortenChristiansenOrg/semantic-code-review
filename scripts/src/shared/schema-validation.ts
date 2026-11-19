/** The typed JSON boundary: values read from disk, Git or command input are
 * `unknown` until one of these functions validates them against their schema. */
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import artifactCommonSchema from "../../../standard/v0.1/schema/common.schema.json";
import manifestSchema from "../../../standard/v0.1/schema/manifest.schema.json";
import specificationSchema from "../../../standard/v0.1/schema/specification.schema.json";
import stageSchema from "../../../standard/v0.1/schema/stage.schema.json";
import feedbackCommonSchema from "../../../standard/v0.1/feedback-schema/common.schema.json";
import feedbackManifestSchema from "../../../standard/v0.1/feedback-schema/manifest.schema.json";
import threadSchema from "../../../standard/v0.1/feedback-schema/thread.schema.json";
import workStageSchema from "../../schemas/work-stage.schema.json";
import stageOrganizationSchema from "../../schemas/stage-organization.schema.json";
import {
  FEEDBACK_MANIFEST_SCHEMA_ID,
  MANIFEST_SCHEMA_ID,
  SPECIFICATION_SCHEMA_ID,
  STAGE_ORGANIZATION_SCHEMA_ID,
  STAGE_SCHEMA_ID,
  THREAD_SCHEMA_ID,
  WORK_STAGE_SCHEMA_ID,
  type FeedbackManifest,
  type ImplementationManifest,
  type Specification,
  type Stage,
  type StageOrganization,
  type Thread,
  type WorkStage,
} from "./documents.js";
import { fail } from "./errors.js";
import { readJson } from "./json.js";
import { isRecord } from "./narrow.js";

/** Every document kind, keyed by its schema identifier. */
export interface DocumentTypes {
  [MANIFEST_SCHEMA_ID]: ImplementationManifest;
  [SPECIFICATION_SCHEMA_ID]: Specification;
  [STAGE_SCHEMA_ID]: Stage;
  [WORK_STAGE_SCHEMA_ID]: WorkStage;
  [STAGE_ORGANIZATION_SCHEMA_ID]: StageOrganization;
  [FEEDBACK_MANIFEST_SCHEMA_ID]: FeedbackManifest;
  [THREAD_SCHEMA_ID]: Thread;
}
export type SchemaId = keyof DocumentTypes;
export type AnyDocument = DocumentTypes[SchemaId];

const SCHEMA_IDS: readonly SchemaId[] = [
  MANIFEST_SCHEMA_ID,
  SPECIFICATION_SCHEMA_ID,
  STAGE_SCHEMA_ID,
  WORK_STAGE_SCHEMA_ID,
  STAGE_ORGANIZATION_SCHEMA_ID,
  FEEDBACK_MANIFEST_SCHEMA_ID,
  THREAD_SCHEMA_ID,
];

export function isSchemaId(value: unknown): value is SchemaId {
  return typeof value === "string" && (SCHEMA_IDS as readonly string[]).includes(value);
}

let ajv: Ajv2020 | undefined;

function schemas(): Ajv2020 {
  if (!ajv) {
    // Schemas are only added here; Ajv compiles and caches each one on first use.
    ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, validateFormats: true });
    addFormats(ajv);
    for (const schema of [
      artifactCommonSchema, manifestSchema, specificationSchema, stageSchema,
      feedbackCommonSchema, feedbackManifestSchema, threadSchema,
      workStageSchema, stageOrganizationSchema,
    ]) ajv.addSchema(schema);
  }
  return ajv;
}

function validator<K extends SchemaId>(id: K): ValidateFunction<DocumentTypes[K]> {
  const compiled = schemas().getSchema<DocumentTypes[K]>(id);
  if (!compiled) throw new Error(`Schema ${id} is not registered.`);
  return compiled;
}

export function schemaErrors(errors: ErrorObject[] | null | undefined, file: string): string {
  return (errors ?? [])
    .map((error) => `${file}${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("\n") || `${file}/ is invalid`;
}

/** True when value is a valid document of this kind. */
export function isDocument<K extends SchemaId>(id: K, value: unknown): value is DocumentTypes[K] {
  return validator(id)(value);
}

/** Validates value as a document of this kind, failing with every schema error. */
export function parseDocument<K extends SchemaId>(id: K, value: unknown, file: string): DocumentTypes[K] {
  const schemaId = isRecord(value) ? value.$schema : undefined;
  if (typeof schemaId !== "string") fail(`${file}: missing string $schema.`);
  if (schemaId !== id) fail(`${file}: unsupported schema ${schemaId}; expected ${id}.`);
  const validate = validator(id);
  if (!validate(value)) fail(schemaErrors(validate.errors, file));
  return value;
}

/** Validates value as a document of any of the given kinds, chosen by its $schema. */
export function parseAnyDocument<K extends SchemaId>(ids: readonly K[], value: unknown, file: string): DocumentTypes[K] {
  const schemaId = isRecord(value) ? value.$schema : undefined;
  if (typeof schemaId !== "string") fail(`${file}: missing string $schema.`);
  const id = ids.find((candidate) => candidate === schemaId);
  if (!id) fail(`${file}: unsupported schema ${schemaId}.`);
  return parseDocument(id, value, file);
}

/** Reads a JSON file and validates it as a document of this kind. */
export function readDocument<K extends SchemaId>(id: K, file: string): DocumentTypes[K] {
  return parseDocument(id, readJson(file), file);
}
