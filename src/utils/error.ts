import { DiagnosticMetadataTags } from '@superblocksteam/shared';

interface TaggedError extends Error {
  tags?: DiagnosticMetadataTags;
}

export function addDiagnosticTagsToError(error: Error, tags: DiagnosticMetadataTags): DiagnosticMetadataTags {
  const taggedError = error as TaggedError;
  if (!taggedError.tags) {
    taggedError.tags = tags;
  } else {
    taggedError.tags = { ...taggedError.tags, ...tags };
  }
  return taggedError.tags;
}

export function getDiagnosticTagsFromError(error: Error): DiagnosticMetadataTags {
  const taggedError = error as TaggedError;
  return taggedError.tags ?? {};
}
