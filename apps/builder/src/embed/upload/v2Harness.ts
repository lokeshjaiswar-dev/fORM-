import { dmsToAnswer } from '@form/registry/profiles/dms-v1';
import type { AnswerValue, Answers, BlockId, FieldBlock } from '@form/schema';
import raw from '@/embed/contract/__fixtures__/fp-bridge-v2.fixtures.json' with { type: 'json' };
import { stampChild, type ChildMessage, type InitMessage, type ParentMessage } from '../bridge/protocolV2.ts';
import { UploadController, type ControllerDeps, type RenderView } from './controller.ts';

/* Test support for the fp-bridge/2 child: the contract's fixtures, and a controller wired to arrays (every message it sends is stamped and schema-checked, as on the wire). */

export const DIALOG = 'dlg-1';
export const REQ = 'r4nd0m-req-0000000001';

type FixtureCase = { name: string; input: unknown; expect: { valid: boolean; why?: string }; via?: string; dir?: string };
export const bridgeCases = (raw as unknown as { cases: FixtureCase[] }).cases;
export const caseInput = (name: string): unknown => {
  const found = bridgeCases.find((c) => c.name === name);
  if (!found) throw new Error(`no fixture case ${name}`);
  return structuredClone(found.input);
};
/** The contract's edit-mode `init`: a masked secret (Tax Id), an increment field, a legacy read-only field, a linked dropdown and a lookup. */
export const v2Init = (): InitMessage => caseInput('init') as InitMessage;

export const F = {
  invoiceNo: 'c2000000-0000-4000-8000-000000000001',
  invoiceDate: 'c2000000-0000-4000-8000-000000000002',
  vendorName: 'c2000000-0000-4000-8000-000000000101',
  taxId: 'c2000000-0000-4000-8000-000000000102',
  category: 'c2000000-0000-4000-8000-000000000103',
  subCategory: 'c2000000-0000-4000-8000-000000000104',
  preferred: 'c2000000-0000-4000-8000-000000000105',
  vendorCode: 'c2000000-0000-4000-8000-000000000106',
  docs: 'c2000000-0000-4000-8000-000000000107',
} as const;

export type ChildOf<T extends ChildMessage['type']> = Extract<ChildMessage, { type: T }>;

export function harness(extra: Partial<ControllerDeps> = {}) {
  const sent: ChildMessage[] = [];
  const renders: Array<RenderView | null> = [];
  const problems: string[] = [];
  const controller = new UploadController({
    dialogId: DIALOG,
    send: (body) => void sent.push(stampChild(body)),
    onRender: (view) => void renders.push(view),
    onProblem: (code, why) => void problems.push(`${code}: ${why}`),
    ...extra,
  });
  const view = () => renders.at(-1)!;
  const ofType = <T extends ChildMessage['type']>(type: T) => sent.filter((m) => m.type === type) as Array<ChildOf<T>>;
  const init = (message: InitMessage = v2Init()) => controller.receive(message);
  const collect = (req: string = REQ, dialogId: string = DIALOG) => controller.receive({ protocol: 'fp-bridge/2', type: 'collect', dialogId, req });
  const send = (message: ParentMessage) => controller.receive(message);
  /** The renderer's answers after the person set `edits` (DMS strings) on top of what the current view started with. */
  const edit = (edits: Record<string, string>, rawAnswers: Record<string, AnswerValue | null> = {}) => {
    const answers: Record<string, AnswerValue> = { ...(view().plan.initialAnswers as Record<string, AnswerValue>) };
    for (const [id, text] of Object.entries(edits)) {
      const block = view().plan.version.definition.blocks[id as BlockId] as FieldBlock;
      const value = dmsToAnswer(block, text);
      if (value === undefined) delete answers[id];
      else answers[id] = { type: block.type, value } as AnswerValue;
    }
    for (const [id, a] of Object.entries(rawAnswers)) {
      if (a === null) delete answers[id];
      else answers[id] = a;
    }
    controller.setAnswers(answers as Answers);
  };
  return { controller, sent, renders, problems, view, ofType, init, collect, send, edit };
}
