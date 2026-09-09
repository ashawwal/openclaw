import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import type { JsonObject } from "./protocol.js";

const CODEX_NATIVE_PROJECT_DOC_MAX_BYTES = 128 * 1024;

export function buildCodexProjectDocThreadConfig(
  config?: JsonObject,
  effectiveNativeConfig?: JsonObject,
): JsonObject {
  const authoredMaxBytes = resolveCodexNativeProjectDocMaxBytes(effectiveNativeConfig);
  const defaults: JsonObject = {
    project_doc_max_bytes: authoredMaxBytes ?? CODEX_NATIVE_PROJECT_DOC_MAX_BYTES,
  };
  return mergeCodexThreadConfigs(defaults, config) ?? defaults;
}

function resolveCodexNativeProjectDocMaxBytes(
  effectiveNativeConfig?: JsonObject,
): number | undefined {
  const authoredMaxBytes = effectiveNativeConfig?.project_doc_max_bytes;
  if (
    authoredMaxBytes !== undefined &&
    (typeof authoredMaxBytes !== "number" ||
      !Number.isSafeInteger(authoredMaxBytes) ||
      authoredMaxBytes < 0)
  ) {
    throw new Error("Codex config/read returned an invalid project_doc_max_bytes value");
  }
  return authoredMaxBytes;
}

export function mergeCodexNativeProjectDocThreadConfig(
  config: JsonObject | undefined,
  effectiveNativeConfig: JsonObject,
): JsonObject | undefined {
  const authoredMaxBytes = resolveCodexNativeProjectDocMaxBytes(effectiveNativeConfig);
  return authoredMaxBytes === undefined
    ? config
    : mergeCodexThreadConfigs({ project_doc_max_bytes: authoredMaxBytes }, config);
}
