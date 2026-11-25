import { z } from 'zod';
import type { DmsElement } from '@form/registry/profiles/dms-v1';
import { createDmsClient, DmsApiError, type DmsClient } from '@/embed/dmsClient';
import type { ResolvedLaunch } from '@/embed/launch';
import {
  DMS_RECORD_ROUTES, diffRecordValues, fieldNameOf, parseRecordJson, writableElements,
  type DmsRecordCreateBody, type DmsRecordRepository as RecordRepository, type DmsRecordUpdateBody, type DmsRecordValues, type LoadedDmsRecord,
} from './contract';

/*
 * Record-mode persistence (DESIGN-v2 section 4). The user's own DMS token goes to the launch's allowlisted `apiBase` and
 * nowhere else (`createDmsClient`). Nothing is sent until `save`; an edit with no change sends nothing.
 */

const MasterEnvelope = z.object({
  data: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string(),
    source: z.string().nullish(),
    form_builder_fields: z.union([z.array(z.record(z.string(), z.unknown())), z.string()]).nullish(),
  }),
});

const RecordEnvelope = z.object({ data: z.object({ json_data: z.unknown() }) });
const SavedEnvelope = z.object({ data: z.object({ id: z.union([z.string(), z.number()]).transform(String) }) });

/** The master was not converted to Forms+: nothing is editable and nothing is written. */
export class NotAFormPlusRecordMaster extends Error {
  constructor() {
    super('This master has not been converted to Forms+');
    this.name = 'NotAFormPlusRecordMaster';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function elementsOf(raw: unknown): DmsElement[] {
  let list: unknown = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      throw new Error('DMS sent a form this page cannot read.');
    }
  }
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('DMS sent a form this page cannot read.');
  return list.filter(isRecord) as DmsElement[];
}

/** A 2xx answer that says `success: false` is a refusal, shown with DMS's own message. */
function refusal(status: number, body: unknown): DmsApiError | null {
  if (isRecord(body) && body['success'] === false) {
    const message = typeof body['message'] === 'string' && body['message'] !== '' ? body['message'] : 'DMS did not save the record.';
    return new DmsApiError(status, message, typeof body['code'] === 'string' || typeof body['code'] === 'number' ? body['code'] : null, body);
  }
  return null;
}

export class DmsRecordRepository implements RecordRepository {
  private readonly client: DmsClient;
  private inFlight: Promise<{ recordId: string }> | null = null;

  constructor(launch: Pick<ResolvedLaunch, 'apiBase' | 'tenantId' | 'workspaceId'>, client?: DmsClient) {
    this.client = client ?? createDmsClient({ apiBase: launch.apiBase, tenantId: launch.tenantId, workspaceId: launch.workspaceId });
  }

  async load(masterId: string, recordId?: string): Promise<LoadedDmsRecord> {
    const master = MasterEnvelope.safeParse(await this.client.request('GET', DMS_RECORD_ROUTES.master(masterId)));
    if (!master.success) throw new Error('DMS sent a master this page cannot read.');
    const { data } = master.data;
    const source = data.source ?? '';
    const base = { masterId: data.id, masterName: data.name, source, recordId: recordId ?? null };
    // Not a Forms+ master: no form, and the record is not even read.
    if (source !== 'formplus') return { ...base, elements: [], values: {} };
    const elements = elementsOf(data.form_builder_fields);
    if (recordId === undefined) return { ...base, elements, values: {} };
    const record = RecordEnvelope.safeParse(await this.client.request('GET', DMS_RECORD_ROUTES.record(masterId, recordId)));
    if (!record.success) throw new Error('DMS sent a record this page cannot read.');
    return { ...base, elements, values: parseRecordJson(record.data.data.json_data) };
  }

  /** `next` is every field's value by field name. Legacy and auto-increment fields are never sent. One save at a time. */
  save(loaded: LoadedDmsRecord, next: DmsRecordValues): Promise<{ recordId: string }> {
    if (this.inFlight) return this.inFlight;
    const run = this.doSave(loaded, next).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async doSave(loaded: LoadedDmsRecord, next: DmsRecordValues): Promise<{ recordId: string }> {
    if (loaded.source !== 'formplus') throw new NotAFormPlusRecordMaster();
    if (loaded.recordId === null) {
      const json_data: DmsRecordValues = {};
      for (const el of writableElements(loaded.elements)) json_data[fieldNameOf(el)] = next[fieldNameOf(el)] ?? '';
      const body: DmsRecordCreateBody = { master_id: loaded.masterId, json_data };
      const response = await this.client.request('POST', DMS_RECORD_ROUTES.create(), body);
      const failed = refusal(200, response);
      if (failed) throw failed;
      const saved = SavedEnvelope.safeParse(response);
      if (!saved.success) throw new Error('DMS did not say which record it saved.');
      return { recordId: saved.data.data.id };
    }
    const changed = diffRecordValues(loaded, next);
    if (changed === null) return { recordId: loaded.recordId };
    const body: DmsRecordUpdateBody = { master_id: loaded.masterId, master_record_id: loaded.recordId, json_data: changed };
    const response = await this.client.request('PATCH', DMS_RECORD_ROUTES.update(loaded.recordId), body);
    const failed = refusal(200, response);
    if (failed) throw failed;
    return { recordId: loaded.recordId };
  }
}
