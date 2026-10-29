/**
 * oxlint JS plugin `form-audit` (architecture §2.7: no answer values ever enter audit metadata). The static half of
 * the rule; `scrubAuditMetadata` in packages/db/src/audit/scrub.ts is the runtime half and uses the same key list
 * (a db test keeps them equal).
 *
 * `form-audit/no-answer-values` checks every `audit.append(tx, org, event)` and `audit.appendDetached(...)` call:
 * the event is an object literal with a string-literal `action` (so the event catalogue test can read every
 * emitted code) and no spreads but `...auditActor(ctx)`; `metadata` is an object literal whose keys, and the names
 * its values are built from, never name an answer container (`answers`, `values`, `payload`, …).
 */
export const ANSWER_KEYS = [
  'answer',
  'answers',
  'value',
  'values',
  'response',
  'responses',
  'payload',
  'data',
  'field',
  'fields',
  'fieldvalues',
  'input',
  'inputs',
  'prefill',
  'submission',
  'submissiondata',
  'body',
  'content',
  'plaintext',
  'decrypted',
  'raw',
];

const ANSWER_KEY_SET = new Set(ANSWER_KEYS);
const isAnswerKey = (key) => ANSWER_KEY_SET.has(String(key).toLowerCase().replace(/[^a-z0-9]/g, ''));
const METHODS = new Set(['append', 'appendDetached']);
const SKIP = new Set(['parent', 'loc', 'range', 'start', 'end']);

function propertyName(p) {
  if (p.computed) return p.key.type === 'Literal' ? String(p.key.value) : null;
  if (p.key.type === 'Identifier') return p.key.name;
  if (p.key.type === 'Literal') return String(p.key.value);
  return null;
}

function isAuditCall(node) {
  const c = node.callee;
  return (
    c.type === 'MemberExpression' &&
    !c.computed &&
    c.object.type === 'Identifier' &&
    c.object.name === 'audit' &&
    c.property.type === 'Identifier' &&
    METHODS.has(c.property.name)
  );
}

const isActorSpread = (p) => p.argument.type === 'CallExpression' && p.argument.callee.type === 'Identifier' && p.argument.callee.name === 'auditActor';

const noAnswerValues = {
  meta: {
    type: 'problem',
    docs: { description: 'Audit events name a literal action and carry no answer values in metadata.' },
    schema: [],
  },
  create(context) {
    /** Every identifier or property name in an expression that names an answer container. */
    function inspect(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Identifier' && isAnswerKey(node.name)) {
        context.report({ node, message: `\`${node.name}\` looks like answer values; audit metadata carries ids and counts only.` });
        return;
      }
      if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && isAnswerKey(node.property.name)) {
        context.report({ node, message: `\`${node.property.name}\` looks like answer values; audit metadata carries ids and counts only.` });
        return;
      }
      if (node.type === 'ObjectExpression') {
        checkObject(node);
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (SKIP.has(k)) continue;
        if (Array.isArray(v)) for (const x of v) inspect(x);
        else if (v && typeof v === 'object' && typeof v.type === 'string') inspect(v);
      }
    }

    function checkObject(obj) {
      for (const p of obj.properties) {
        if (p.type === 'SpreadElement') {
          context.report({ node: p, message: 'No spreads in audit metadata: list the fields.' });
          continue;
        }
        const name = propertyName(p);
        if (name !== null && isAnswerKey(name)) {
          context.report({ node: p.key, message: `Audit metadata key \`${name}\` names answer values.` });
          continue;
        }
        if (p.computed) inspect(p.key);
        inspect(p.value);
      }
    }

    return {
      CallExpression(node) {
        if (!isAuditCall(node)) return;
        const event = node.arguments[2];
        if (!event || event.type !== 'ObjectExpression') {
          context.report({ node, message: 'Pass the audit event as an object literal, so the call site can be checked.' });
          return;
        }
        let action = null;
        for (const p of event.properties) {
          if (p.type === 'SpreadElement') {
            if (!isActorSpread(p)) context.report({ node: p, message: 'No spreads in an audit event except `...auditActor(ctx)`.' });
            continue;
          }
          const name = propertyName(p);
          if (name === 'action') action = p.value;
          if (name === 'metadata') {
            if (p.value.type === 'ObjectExpression') checkObject(p.value);
            else context.report({ node: p.value, message: 'Audit `metadata` must be an object literal.' });
          }
        }
        if (!action || action.type !== 'Literal' || typeof action.value !== 'string') {
          context.report({ node: action ?? event, message: 'Audit `action` must be a string literal from AUDIT_EVENTS.' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'form-audit' },
  rules: { 'no-answer-values': noAnswerValues },
};
