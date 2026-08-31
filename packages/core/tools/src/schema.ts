/** Unified JSON-value schema DSL, inference, compilation, and typed tool helper. @module dsh-tools/schema */

export type {
  ArrayValueSchemaSpec,
  BooleanValueSchemaSpec,
  InferArgs,
  InferValue,
  IntegerValueSchemaSpec,
  JsonValueSchemaSpec,
  NullValueSchemaSpec,
  NumberValueSchemaSpec,
  ObjectValueSchemaSpec,
  OneOfValueSchemaSpec,
  ParameterJsonSchema,
  ParameterPropertySpec,
  ParameterSchemaSpec,
  StringValueSchemaSpec,
  ValueSchemaAnnotations,
  ValueSchemaSpec,
} from './schema-spec.ts'
export { defineTool, parameterSchemaSpecToJsonSchema, ToolArgsError, validateArgs, valueSchemaSpecToJsonSchema } from './define-tool.ts'
export type { DefineToolOptions } from './define-tool.ts'
