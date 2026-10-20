/**
 * A JSON Schema 2020-12 validator for tests: what an instance breaks of a schema, by pointer. It
 * knows the keywords the agent folder documents use, resolves `$ref` to `#` and `#/$defs/<name>`,
 * and throws on any other keyword, so a document can never pass by using one it skips. Core has
 * no validator dependency, and `z.fromJSONSchema` is too loose to test against (it does not
 * enforce `required` without `properties`, nor `additionalProperties` beside `oneOf`).
 */
type Json = Record<string, unknown>;

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "$comment", "title", "description", "default", "examples", "format", "deprecated", "readOnly", "writeOnly"]);

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const show = (value: unknown) => JSON.stringify(value);

const typeOf: Record<string, (value: unknown) => boolean> = {
  null: (value) => value === null,
  boolean: (value) => typeof value === "boolean",
  number: (value) => typeof value === "number",
  integer: (value) => Number.isInteger(value),
  string: (value) => typeof value === "string",
  array: Array.isArray,
  object: isObject,
};

const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && equal(a[key], b[key]));
  }
  return a === b;
};

/** What `instance` breaks of `root`, each as `<pointer>: <problem>`; empty when it is valid. */
export function schemaErrors(root: Json, instance: unknown): string[] {
  const resolve = (ref: string): unknown => {
    if (ref === "#") return root;
    const name = /^#\/\$defs\/([^/]+)$/.exec(ref)?.[1];
    const defs = isObject(root.$defs) ? root.$defs : {};
    if (name === undefined || !(name in defs)) throw new Error(`The test validator cannot resolve $ref ${ref}`);
    return defs[name];
  };

  const check = (schema: unknown, value: unknown, at: string): string[] => {
    if (schema === true) return [];
    if (schema === false) return [`${at}: no value is allowed`];
    if (!isObject(schema)) throw new Error(`${at}: ${show(schema)} is not a schema`);
    const errors: string[] = [];
    const fail = (message: string) => errors.push(`${at || "/"}: ${message}`);
    for (const [keyword, rule] of Object.entries(schema)) {
      switch (keyword) {
        case "$ref":
          errors.push(...check(resolve(rule as string), value, at));
          break;
        case "type": {
          const types = Array.isArray(rule) ? (rule as string[]) : [rule as string];
          if (!types.some((type) => typeOf[type]!(value))) fail(`${show(value)} is not ${types.join(" or ")}`);
          break;
        }
        case "enum":
          if (!(rule as unknown[]).some((item) => equal(item, value))) fail(`${show(value)} is not one of ${show(rule)}`);
          break;
        case "const":
          if (!equal(rule, value)) fail(`${show(value)} is not ${show(rule)}`);
          break;
        case "properties":
          if (isObject(value))
            for (const [key, child] of Object.entries(rule as Json)) if (key in value) errors.push(...check(child, value[key], `${at}/${key}`));
          break;
        case "patternProperties":
          if (isObject(value))
            for (const [pattern, child] of Object.entries(rule as Json))
              for (const key of Object.keys(value)) if (new RegExp(pattern, "u").test(key)) errors.push(...check(child, value[key], `${at}/${key}`));
          break;
        case "additionalProperties":
          if (isObject(value)) {
            const named = Object.keys(isObject(schema.properties) ? schema.properties : {});
            const patterns = Object.keys(isObject(schema.patternProperties) ? schema.patternProperties : {}).map((pattern) => new RegExp(pattern, "u"));
            for (const key of Object.keys(value))
              if (!named.includes(key) && !patterns.some((pattern) => pattern.test(key)))
                errors.push(...(rule === false ? [`${at}/${key}: is not allowed`] : check(rule, value[key], `${at}/${key}`)));
          }
          break;
        case "propertyNames":
          if (isObject(value)) for (const key of Object.keys(value)) errors.push(...check(rule, key, `${at}/${key}`).map((error) => `${error} (the key)`));
          break;
        case "required":
          if (isObject(value)) for (const key of rule as string[]) if (!(key in value)) fail(`${key} is required`);
          break;
        case "minProperties":
          if (isObject(value) && Object.keys(value).length < (rule as number)) fail(`has fewer than ${rule} properties`);
          break;
        case "maxProperties":
          if (isObject(value) && Object.keys(value).length > (rule as number)) fail(`has more than ${rule} properties`);
          break;
        case "items":
          if (Array.isArray(value)) {
            const from = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
            value.slice(from).forEach((item, index) => errors.push(...check(rule, item, `${at}/${index + from}`)));
          }
          break;
        case "prefixItems":
          if (Array.isArray(value)) (rule as unknown[]).forEach((child, index) => index < value.length && errors.push(...check(child, value[index], `${at}/${index}`)));
          break;
        case "minItems":
          if (Array.isArray(value) && value.length < (rule as number)) fail(`has fewer than ${rule} items`);
          break;
        case "maxItems":
          if (Array.isArray(value) && value.length > (rule as number)) fail(`has more than ${rule} items`);
          break;
        case "uniqueItems":
          if (rule === true && Array.isArray(value) && value.some((item, index) => value.findIndex((other) => equal(item, other)) !== index)) fail("has duplicate items");
          break;
        case "minLength":
          if (typeof value === "string" && [...value].length < (rule as number)) fail(`is shorter than ${rule}`);
          break;
        case "maxLength":
          if (typeof value === "string" && [...value].length > (rule as number)) fail(`is longer than ${rule}`);
          break;
        case "pattern":
          if (typeof value === "string" && !new RegExp(rule as string, "u").test(value)) fail(`${show(value)} does not match ${rule}`);
          break;
        case "minimum":
          if (typeof value === "number" && value < (rule as number)) fail(`is below ${rule}`);
          break;
        case "maximum":
          if (typeof value === "number" && value > (rule as number)) fail(`is above ${rule}`);
          break;
        case "exclusiveMinimum":
          if (typeof value === "number" && value <= (rule as number)) fail(`is not above ${rule}`);
          break;
        case "exclusiveMaximum":
          if (typeof value === "number" && value >= (rule as number)) fail(`is not below ${rule}`);
          break;
        case "allOf":
          for (const child of rule as unknown[]) errors.push(...check(child, value, at));
          break;
        case "anyOf":
          if (!(rule as unknown[]).some((child) => check(child, value, at).length === 0)) fail("matches none of anyOf");
          break;
        case "oneOf": {
          const matches = (rule as unknown[]).filter((child) => check(child, value, at).length === 0).length;
          if (matches !== 1) fail(`matches ${matches} of oneOf, not exactly one`);
          break;
        }
        default:
          if (!ANNOTATIONS.has(keyword)) throw new Error(`The test validator does not know the keyword ${keyword} (at ${at || "/"})`);
      }
    }
    return errors;
  };

  return check(root, instance, "");
}
