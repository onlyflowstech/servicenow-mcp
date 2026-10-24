/**
 * Size checks that run before a schema looks at any element.
 *
 * A schema library validating an array, record, or union visits every element
 * and can record one issue (or a tree of issues, for a union) per element
 * that fails. A `.max(n)` constraint marks the result invalid but does not
 * stop that walk, so an oversized collection of failing elements costs time
 * and memory in proportion to its length, not to `n`.
 *
 * The helpers here put a plain JavaScript check in front of the schema. When
 * the check fails it reports one fatal issue and the wrapped schema never
 * runs. The checks read only `Array.isArray`, `length` and own keys, so they
 * do not depend on schema-library internals and behave the same across
 * library versions. Wrapping uses `z.preprocess`, which JSON Schema
 * conversion renders as the wrapped schema, so the schema clients see is
 * unchanged.
 *
 * @module bounded-input
 */

import { z } from "zod";

/** Return a fixed message to reject the value, or `undefined` to let the schema run. */
export type StructuralCheck = (value: unknown) => string | undefined;

/**
 * Run `check` before `schema`; a failing check is one fatal issue and the
 * schema is skipped.
 */
export function withStructuralCheck<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  check: StructuralCheck
): z.ZodEffects<TSchema, z.output<TSchema>, z.input<TSchema>> {
  // The check returns its input unchanged, so the accepted input type is the
  // wrapped schema's; preprocess alone would widen it to unknown.
  return z.preprocess((value, context) => {
    const message = check(value);
    if (message !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message, fatal: true });
    }
    return value;
  }, schema) as z.ZodEffects<TSchema, z.output<TSchema>, z.input<TSchema>>;
}

/** Message matching the schema library's own `.max()` text for arrays. */
function arrayTooLongMessage(max: number): string {
  return `Array must contain at most ${max} element(s)`;
}

/**
 * An array of `element`, at most `max` long, whose length is checked before
 * any element is parsed. Pass `min` for a lower bound.
 */
export function boundedArray<TElement extends z.ZodTypeAny>(
  element: TElement,
  max: number,
  options: { readonly min?: number } = {}
) {
  let array = z.array(element).max(max);
  if (options.min !== undefined) array = array.min(options.min);
  return withStructuralCheck(array, (value) =>
    Array.isArray(value) && value.length > max ? arrayTooLongMessage(max) : undefined
  );
}

/** True when `value` is a non-array object with more than `max` own enumerable keys. */
export function hasMoreOwnKeysThan(value: unknown, max: number): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let count = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key) && ++count > max) return true;
  }
  return false;
}

/**
 * A record schema whose own-key count is checked before any key or value is
 * parsed.
 */
export function boundedRecord<TSchema extends z.ZodTypeAny>(
  record: TSchema,
  maxKeys: number,
  message: string
) {
  return withStructuralCheck(record, (value) =>
    hasMoreOwnKeysThan(value, maxKeys) ? message : undefined
  );
}
