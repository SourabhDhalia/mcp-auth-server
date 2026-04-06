// SPDX-License-Identifier: Apache-2.0

import * as z from "zod/v4";

type JsonSchema = Record<string, unknown>;

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applySharedMetadata(
  schema: z.ZodTypeAny,
  source: JsonSchema,
): z.ZodTypeAny {
  const description =
    typeof source.description === "string"
      ? source.description
      : typeof source.title === "string"
        ? source.title
        : undefined;

  return description ? schema.describe(description) : schema;
}

function withNullability(
  schema: z.ZodTypeAny,
  source: JsonSchema,
): z.ZodTypeAny {
  const typeValue = source.type;
  const allowsNull =
    source.nullable === true ||
    (Array.isArray(typeValue) && typeValue.includes("null"));

  return allowsNull ? schema.nullable() : schema;
}

function buildEnumSchema(values: unknown[]): z.ZodTypeAny {
  const normalizedValues = values.map((value) => {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return value;
    }

    return JSON.stringify(value);
  });

  if (normalizedValues.length === 1) {
    return z.literal(normalizedValues[0]);
  }

  const literals = normalizedValues.map((value) => z.literal(value));
  return z.union(
    literals as [
      z.ZodLiteral<string | number | boolean | null>,
      ...z.ZodLiteral<string | number | boolean | null>[],
    ],
  );
}

function buildStringSchema(schema: JsonSchema): z.ZodTypeAny {
  let output = z.string();

  if (typeof schema.minLength === "number") {
    output = output.min(schema.minLength);
  }

  if (typeof schema.maxLength === "number") {
    output = output.max(schema.maxLength);
  }

  if (schema.format === "email") {
    output = output.email();
  }

  if (schema.format === "uri" || schema.format === "url") {
    output = output.url();
  }

  return output;
}

function buildNumberSchema(schema: JsonSchema, integer: boolean): z.ZodTypeAny {
  let output = integer ? z.number().int() : z.number();

  if (typeof schema.minimum === "number") {
    output = output.min(schema.minimum);
  }

  if (typeof schema.maximum === "number") {
    output = output.max(schema.maximum);
  }

  return output;
}

function buildObjectSchema(schema: JsonSchema): z.ZodTypeAny {
  const properties = isSchemaObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? new Set(
        schema.required
          .filter((value): value is string => typeof value === "string")
          .map((value) => value),
      )
    : new Set<string>();

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const field = convertJsonSchema(propertySchema);
    shape[name] = required.has(name) ? field : field.optional();
  }

  let output = z.object(shape);
  if (schema.additionalProperties === true) {
    output = output.catchall(z.unknown());
  } else if (isSchemaObject(schema.additionalProperties)) {
    output = output.catchall(convertJsonSchema(schema.additionalProperties));
  }

  return output;
}

export function convertJsonSchema(schema: unknown): z.ZodTypeAny {
  if (!isSchemaObject(schema)) {
    return z.unknown();
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return applySharedMetadata(withNullability(buildEnumSchema(enumValues), schema), schema);
  }

  const typeValue = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;

  let output: z.ZodTypeAny;
  switch (typeValue) {
    case "string":
      output = buildStringSchema(schema);
      break;
    case "integer":
      output = buildNumberSchema(schema, true);
      break;
    case "number":
      output = buildNumberSchema(schema, false);
      break;
    case "boolean":
      output = z.boolean();
      break;
    case "array":
      output = z.array(convertJsonSchema(schema.items));
      break;
    case "object":
      output = buildObjectSchema(schema);
      break;
    default:
      if (isSchemaObject(schema.properties) || schema.additionalProperties !== undefined) {
        output = buildObjectSchema(schema);
      } else {
        output = z.unknown();
      }
      break;
  }

  return applySharedMetadata(withNullability(output, schema), schema);
}

export function jsonSchemaToToolInput(
  schema: unknown,
): Record<string, z.ZodTypeAny> {
  if (!isSchemaObject(schema)) {
    return {};
  }

  if (schema.type === "object" || isSchemaObject(schema.properties)) {
    const properties = isSchemaObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? new Set(
          schema.required.filter(
            (value): value is string => typeof value === "string",
          ),
        )
      : new Set<string>();

    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      const field = convertJsonSchema(propertySchema);
      shape[name] = required.has(name) ? field : field.optional();
    }

    return shape;
  }

  return {
    input: convertJsonSchema(schema),
  };
}
