import type { FileRef, FileUploadConfig } from '@form/schema';
import { defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { FILE_OPS, NUMBER_OPS } from '../operators.ts';
import { asciiLower } from '../util/text.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

const MIB = 1024 * 1024;
const SEPARATOR = '; ';

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : asciiLower(name.slice(dot + 1));
};

/** Both allowlists must match when set; `type/*` matches a whole family. An empty list allows any. */
export function acceptsFile(file: Pick<FileRef, 'name' | 'mime'>, accept: FileUploadConfig['accept']): boolean {
  const extensions = accept.extensions.map((e) => asciiLower(e.replace(/^\./, '')));
  const mime = asciiLower(file.mime);
  const mimeOk = accept.mimeTypes.length === 0 || accept.mimeTypes.some((m) => {
    const allowed = asciiLower(m);
    return allowed.endsWith('/*') ? mime.startsWith(allowed.slice(0, -1)) : mime === allowed;
  });
  return (extensions.length === 0 || extensions.includes(extensionOf(file.name))) && mimeOk;
}

/** FLD-26/27. Files are uploaded first; the answer only references them (S10). */
export const fileUpload = defineField({
  type: 'file_upload',
  palette: [entry('file_upload', null, 'media', PALETTE_LABELS['palette.file_upload'], 'paperclip', ['file', 'upload', 'attachment', 'document', 'photo'])],
  defaultConfig: () => ({
    maxFiles: 1,
    maxFileBytes: 10 * MIB,
    accept: {
      extensions: ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'],
      mimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    },
    capture: 'none',
    stripMetadata: true,
    scan: 'async',
  }),
  checkConfig: (config, report) => {
    if (config.minFiles !== undefined && config.minFiles > config.maxFiles) report('minFiles must not exceed maxFiles', ['minFiles']);
    if (config.minFileBytes !== undefined && config.minFileBytes > config.maxFileBytes) report('minFileBytes must not exceed maxFileBytes', ['minFileBytes']);
  },
  checkAnswer: (value, block, _state, report) => {
    const { minFiles, maxFiles, minFileBytes, maxFileBytes, accept } = block.config;
    if (value.length > maxFiles) report('too_many_files');
    if (minFiles !== undefined && value.length < minFiles) report('too_few_files');
    const seen = new Set<string>();
    value.forEach((file, i) => {
      if (seen.has(file.fileId)) report('invalid_format', [i, 'fileId']);
      seen.add(file.fileId);
      if (file.sizeBytes > maxFileBytes) report('file_too_large', [i, 'sizeBytes']);
      if (minFileBytes !== undefined && file.sizeBytes < minFileBytes) report('file_too_small', [i, 'sizeBytes']);
      if (!acceptsFile(file, accept)) report('file_type_not_allowed', [i]);
      if (file.scan === 'infected') report('file_infected', [i, 'scan']);
    });
  },
  paths: { '': 'file', count: 'number' },
  operators: { file: FILE_OPS, number: NUMBER_OPS },
  toScalar: (value, path) => {
    if (isRootPath(path)) return { t: 'list', of: 'text', items: value.map((f) => ({ t: 'text', v: f.name })) };
    return path === 'count' ? countScalar(value.length) : NULL;
  },
  isEmpty: (value) => value.length === 0,
  cells: (value) => [value.map((f) => f.name).join(SEPARATOR)],
});
