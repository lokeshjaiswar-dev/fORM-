import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteTemplate, templateForBinding, withTenant, type TenantCtx, type Tx } from '../src/index.ts';
import { failure, HASH, insertTemplate, insertVersion, pgCode, SEED_SEARCH_WORD, seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';

let t: TestDb;
let seed: Seed;
let seeder: pg.Pool;
let agg: pg.Pool;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
  seeder = new pg.Pool({ connectionString: t.urls.fr_template_seeder, max: 2 });
  agg = new pg.Pool({ connectionString: t.urls.fr_system_agg, max: 1 });
});
afterAll(async () => {
  await seeder?.end();
  await agg?.end();
  await t?.close();
});

type Ctx = Omit<TenantCtx, 'requestId'>;
const EDITOR = ['forms.read', 'forms.edit', 'templates.use', 'templates.create_personal'];
const OWNER = [...EDITOR, 'templates.govern', 'templates.approve', 'templates.manage_categories'];

const editorB = (): Ctx => ({ orgId: seed.b.orgId, actor: 'user', userId: seed.b.editorId, perms: EDITOR, teamIds: [seed.b.teamId] });
const viewerB = (): Ctx => ({ orgId: seed.b.orgId, actor: 'user', userId: seed.b.viewerId, perms: ['forms.read'] });
const ownerB = (): Ctx => ({ orgId: seed.b.orgId, actor: 'user', userId: seed.b.ownerId, perms: OWNER });
const apiKeyB = (): Ctx => ({ orgId: seed.b.orgId, actor: 'api_key', perms: ['forms.read', 'templates.use'] });
const systemB = (): Ctx => ({ orgId: seed.b.orgId, actor: 'system' });
const respondentB = (): Ctx => ({ orgId: seed.b.orgId, actor: 'respondent', subjectIds: [randomUUID()] });

function run<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(t.app.db, { ...ctx, requestId: 'templates' }, fn);
}

async function ids(ctx: Ctx, query: SQL): Promise<string[]> {
  return run(ctx, async (tx) => (await tx.execute<{ id: string }>(query)).rows.map((r) => r.id).sort());
}

const visibleTemplates = (ctx: Ctx) => ids(ctx, sql`select id from templates`);
const visibleVersions = (ctx: Ctx) => ids(ctx, sql`select id from template_versions`);
const sorted = (...xs: string[]) => [...xs].sort();

function search(ctx: Ctx, q: string): Promise<string[]> {
  return ids(
    ctx,
    sql`select template_version_id as id from template_localizations
        where search @@ websearch_to_tsquery(template_search_config(locale), unaccent(${q}))`,
  );
}

describe('template visibility by scope (templates spec §2.1)', () => {
  it('a member sees system rows, org templates, their teams’ templates and their own personal ones', async () => {
    const b = seed.b.tpl;
    expect(await visibleTemplates(editorB())).toEqual(sorted(seed.system.templateId, b.orgTemplateId, b.forkTemplateId, b.teamTemplateId, b.personalTemplateId));
  });

  it('a peer sees neither another member’s personal templates nor teams they are not in', async () => {
    const b = seed.b.tpl;
    expect(await visibleTemplates(viewerB())).toEqual(sorted(seed.system.templateId, b.orgTemplateId, b.forkTemplateId));
    expect(await visibleVersions(viewerB())).toEqual(sorted(seed.system.versionId, b.orgV1Id, b.forkV1Id));
    const links = await ids(viewerB(), sql`select template_id as id from template_category_links`);
    expect(links).not.toContain(b.personalTemplateId);
    expect(links).toContain(b.orgTemplateId);
  });

  it('templates.govern sees every template of the org', async () => {
    const b = seed.b.tpl;
    const owner = { ...ownerB(), teamIds: [] };
    expect(await visibleTemplates(owner)).toEqual(sorted(seed.system.templateId, b.orgTemplateId, b.forkTemplateId, b.teamTemplateId, b.personalTemplateId));
  });

  it('api-key, job and platform actors see system and org templates without raising; respondents and no context see none', async () => {
    const b = seed.b.tpl;
    for (const ctx of [apiKeyB(), systemB(), { orgId: seed.b.orgId, actor: 'platform' } as Ctx]) {
      expect(await visibleTemplates(ctx), ctx.actor).toEqual(sorted(seed.system.templateId, b.orgTemplateId, b.forkTemplateId));
      expect(await visibleVersions(ctx), ctx.actor).toEqual(sorted(seed.system.versionId, b.orgV1Id, b.forkV1Id));
    }
    for (const table of ['templates', 'template_versions', 'template_localizations', 'template_categories', 'template_category_links', 'template_stats_daily']) {
      expect(await run(respondentB(), async (tx) => (await tx.execute(sql`select 1 from ${sql.identifier(table)}`)).rows.length), table).toBe(0);
      const { rows } = await t.app.pool.query(`select 1 from ${table}`);
      expect(rows.length, table).toBe(0);
    }
  });

  it('a template of another org is not there at all (404, not 403)', async () => {
    const a = seed.a.tpl;
    for (const ctx of [ownerB(), editorB(), apiKeyB(), systemB()]) {
      const found = await run(ctx, async (tx) => ({
        template: (await tx.execute(sql`select 1 from templates where id = ${a.orgTemplateId}`)).rows.length,
        version: (await tx.execute(sql`select 1 from template_versions where id in (${a.orgV1Id}, ${a.orgDraftId})`)).rows.length,
        localization: (await tx.execute(sql`select 1 from template_localizations where template_version_id = ${a.orgV1Id}`)).rows.length,
        links: (await tx.execute(sql`select 1 from template_category_links where template_id = ${a.orgTemplateId}`)).rows.length,
      }));
      expect(found, ctx.actor).toEqual({ template: 0, version: 0, localization: 0, links: 0 });
    }
  });
});

describe('drafts (templates spec §2.2)', () => {
  it('are invisible to non-reviewers and visible to their author and to templates.approve', async () => {
    const draft = seed.b.tpl.orgDraftId;
    expect(await visibleVersions(editorB())).not.toContain(draft);
    expect(await visibleVersions(apiKeyB())).not.toContain(draft);
    expect(await visibleVersions(systemB())).not.toContain(draft);
    expect(await visibleVersions({ ...ownerB(), perms: ['forms.read'] })).toContain(draft);
    expect(await visibleVersions({ ...editorB(), perms: ['templates.approve'] })).toContain(draft);
  });

  it('do not leak through the localizations a search reads', async () => {
    const draft = seed.b.tpl.orgDraftId;
    expect(await search(editorB(), SEED_SEARCH_WORD)).not.toContain(draft);
    expect(await search(ownerB(), SEED_SEARCH_WORD)).toContain(draft);
  });

  it('a statement without WHERE updates or deletes no draft the caller cannot see', async () => {
    const orgId = randomUUID();
    const author = randomUUID();
    const templateId = randomUUID();
    const draft = randomUUID();
    await t.owner.query('insert into orgs (id, slug, name) values ($1, $2, $3)', [orgId, `drafts-${orgId.slice(0, 8)}`, 'Drafts only']);
    await insertTemplate(t.owner, { id: templateId, orgId, scope: 'org', slug: 'only-a-draft', createdBy: author });
    await insertVersion(t.owner, { id: draft, templateId, version: 1, state: 'draft', createdBy: author, title: 'Only a draft' });
    const peer: Ctx = { orgId, actor: 'user', userId: randomUUID(), perms: EDITOR };
    const touched = await run(peer, async (tx) => ({
      updated: (await tx.execute(sql`update template_versions set changelog = 'peer'`)).rowCount,
      localizations: (await tx.execute(sql`update template_localizations set summary = 'peer'`)).rowCount,
      deletedLocalizations: (await tx.execute(sql`delete from template_localizations`)).rowCount,
      deleted: (await tx.execute(sql`delete from template_versions`)).rowCount,
    }));
    expect(touched).toEqual({ updated: 0, localizations: 0, deletedLocalizations: 0, deleted: 0 });
    for (const ctx of [{ ...peer, userId: author }, { ...peer, perms: ['templates.approve'] }]) {
      expect(await run(ctx, async (tx) => (await tx.execute(sql`update template_versions set changelog = 'reviewed'`)).rowCount)).toBe(1);
    }
    const { rows } = await t.owner.query('select changelog from template_versions where id = $1', [draft]);
    expect(rows).toEqual([{ changelog: 'reviewed' }]);
  });

  it('of system templates are visible to no org, reviewers included', async () => {
    const templateId = randomUUID();
    const draft = randomUUID();
    await insertTemplate(t.owner, { id: templateId, orgId: null, scope: 'system', slug: `core/draft-${templateId.slice(0, 8)}`, createdBy: null });
    await insertVersion(t.owner, { id: draft, templateId, version: 1, state: 'in_review', createdBy: null, title: `System review ${SEED_SEARCH_WORD}` });
    for (const ctx of [ownerB(), { ...editorB(), perms: ['templates.approve'] }, systemB()]) {
      expect(await visibleVersions(ctx), ctx.actor).not.toContain(draft);
      expect(await search(ctx, SEED_SEARCH_WORD), ctx.actor).not.toContain(draft);
    }
  });
});

describe('search over localizations (FTS)', () => {
  it('finds the org’s visible versions and system ones, never another org’s', async () => {
    const b = seed.b.tpl;
    expect(await search(editorB(), SEED_SEARCH_WORD)).toEqual(sorted(seed.system.versionId, b.orgV1Id, b.teamV1Id, b.personalV1Id, b.forkV1Id));
    expect(await search(viewerB(), SEED_SEARCH_WORD)).toEqual(sorted(seed.system.versionId, b.orgV1Id, b.forkV1Id));
    const titles = await run(ownerB(), async (tx) => (await tx.execute<{ title: string }>(sql`select title from template_localizations`)).rows.map((r) => r.title));
    expect(titles.some((x) => x.startsWith('a-'))).toBe(false);
  });

  it('weights title over summary over field labels, unaccented, stemmed for English', async () => {
    const { rows } = await t.owner.query<{ search: string }>('select search::text from template_localizations where template_version_id = $1', [seed.b.tpl.orgV1Id]);
    expect(rows[0]!.search).toMatch(/'onboard':\d+A/);
    expect(rows[0]!.search).toMatch(/'summari':\d+B/);
    expect(rows[0]!.search).toMatch(/'email':\d+C/);
    const id = randomUUID();
    const versionId = randomUUID();
    await insertTemplate(t.owner, { id, orgId: seed.b.orgId, scope: 'org', slug: `cafe-${id.slice(0, 8)}`, createdBy: seed.b.ownerId });
    await insertVersion(t.owner, { id: versionId, templateId: id, version: 1, state: 'published', createdBy: seed.b.ownerId, title: 'Café registrations' });
    expect(await search(editorB(), 'cafe registration')).toEqual([versionId]);
  });
});

describe('use, diff, fork and export across orgs', () => {
  const bindingFor = (orgId: string, formId: string, templateId: string, versionId: string) =>
    sql`insert into form_template_bindings (id, org_id, form_id, template_id, template_version_id, kind, id_map)
        values (${randomUUID()}, ${orgId}, ${formId}, ${templateId}, ${versionId}, 'form', '{}')`;

  it('use: a binding can name a system template or one of the org, never another org’s', async () => {
    const b = seed.b;
    await run(editorB(), (tx) => tx.execute(bindingFor(b.orgId, b.formIds[1], seed.system.templateId, seed.system.versionId)));
    await run(editorB(), (tx) => tx.execute(bindingFor(b.orgId, b.formIds[1], b.tpl.orgTemplateId, b.tpl.orgV1Id)));
    expect(pgCode(await failure(run(editorB(), (tx) => tx.execute(bindingFor(b.orgId, b.formIds[1], seed.a.tpl.orgTemplateId, seed.a.tpl.orgV1Id)))))).toBe('23503');
    // Another org's version under a template of one's own: the version must be the template's.
    expect(pgCode(await failure(run(editorB(), (tx) => tx.execute(bindingFor(b.orgId, b.formIds[1], b.tpl.orgTemplateId, seed.a.tpl.orgV1Id)))))).toBe('23503');
    // Another org's form.
    expect(pgCode(await failure(run(editorB(), (tx) => tx.execute(bindingFor(b.orgId, seed.a.formIds[0], seed.system.templateId, seed.system.versionId)))))).toBe('23503');
  });

  it('diff: template_for_binding reads the bound version of the org’s own bindings only', async () => {
    const bound = await run(apiKeyB(), (tx) => templateForBinding(tx, seed.b.tpl.bindingId));
    expect(bound).toMatchObject({
      bindingId: seed.b.tpl.bindingId,
      formId: seed.b.formIds[0],
      templateId: seed.b.tpl.orgTemplateId,
      templateVersionId: seed.b.tpl.orgV1Id,
      templateOrgId: seed.b.orgId,
      scope: 'org',
      kind: 'form',
      version: 1,
      state: 'published',
      templateDeletedAt: null,
    });
    expect(bound?.payload).toMatchObject({ kind: 'form' });
    expect(bound?.payloadHash).toEqual(new Uint8Array(HASH));
    expect(await run(systemB(), (tx) => templateForBinding(tx, seed.b.tpl.systemBindingId))).toMatchObject({ templateOrgId: null, scope: 'system' });
    expect(await run(ownerB(), (tx) => templateForBinding(tx, seed.a.tpl.bindingId))).toBeNull();
    expect(await run(respondentB(), (tx) => templateForBinding(tx, seed.b.tpl.bindingId))).toBeNull();
    expect(await run(ownerB(), (tx) => templateForBinding(tx, randomUUID()))).toBeNull();
  });

  it('diff: a soft-deleted template still resolves through its binding', async () => {
    const b = seed.b;
    const id = randomUUID();
    const versionId = randomUUID();
    const bindingId = randomUUID();
    await insertTemplate(t.owner, { id, orgId: b.orgId, scope: 'org', slug: `gone-${id.slice(0, 8)}`, createdBy: b.ownerId });
    await insertVersion(t.owner, { id: versionId, templateId: id, version: 1, state: 'published', createdBy: b.ownerId, title: 'Going away' });
    await run(editorB(), (tx) =>
      tx.execute(sql`insert into form_template_bindings (id, org_id, form_id, template_id, template_version_id, kind, id_map)
                     values (${bindingId}, ${b.orgId}, ${b.formIds[0]}, ${id}, ${versionId}, 'form', '{}')`),
    );
    expect(await run(ownerB(), (tx) => deleteTemplate(tx, id))).toBe(true);
    expect(await visibleTemplates(ownerB())).not.toContain(id);
    expect(await visibleVersions(ownerB())).not.toContain(versionId);
    const bound = await run(editorB(), (tx) => templateForBinding(tx, bindingId));
    expect(bound).toMatchObject({ templateId: id, templateVersionId: versionId, templateDeletedAt: expect.any(Date) });
  });

  describe('a reference names only a version the caller can read', () => {
    const hidden = { systemReviewId: randomUUID(), systemTemplateId: randomUUID(), personalTemplateId: randomUUID(), personalDraftId: randomUUID() };
    beforeAll(async () => {
      const b = seed.b;
      await insertTemplate(t.owner, { id: hidden.systemTemplateId, orgId: null, scope: 'system', slug: `core/secret-${hidden.systemTemplateId.slice(0, 8)}`, createdBy: null });
      await insertVersion(t.owner, { id: hidden.systemReviewId, templateId: hidden.systemTemplateId, version: 1, state: 'in_review', createdBy: null, title: 'System secret draft' });
      await insertTemplate(t.owner, {
        id: hidden.personalTemplateId,
        orgId: b.orgId,
        scope: 'personal',
        slug: `private-${hidden.personalTemplateId.slice(0, 8)}`,
        ownerUserId: b.editorId,
        createdBy: b.editorId,
      });
      await insertVersion(t.owner, { id: hidden.personalDraftId, templateId: hidden.personalTemplateId, version: 1, state: 'draft', createdBy: b.editorId, title: 'Editor private draft' });
    });
    const invisible = (): [string, string][] => [
      [hidden.systemTemplateId, hidden.systemReviewId],
      [hidden.personalTemplateId, hidden.personalDraftId],
      [seed.b.tpl.teamTemplateId, seed.b.tpl.teamV1Id],
    ];

    it('use: a binding of a system draft, a peer’s personal draft or another team’s template is refused as missing', async () => {
      const b = seed.b;
      for (const [templateId, versionId] of invisible()) {
        expect(pgCode(await failure(run(viewerB(), (tx) => tx.execute(bindingFor(b.orgId, b.formIds[1], templateId, versionId))))), versionId).toBe('23503');
      }
      // Reviewers of the org see no system draft either; the author binds their own draft.
      expect(pgCode(await failure(run(ownerB(), (tx) => tx.execute(bindingFor(b.orgId, b.formIds[1], hidden.systemTemplateId, hidden.systemReviewId)))))).toBe('23503');
      await run(editorB(), (tx) => tx.execute(bindingFor(b.orgId, b.formIds[1], hidden.personalTemplateId, hidden.personalDraftId)));
      // Re-pointing a binding at a hidden version of its template is refused too; its other columns stay writable.
      const bindingId = randomUUID();
      await t.owner.query(
        `insert into form_template_bindings (id, org_id, form_id, template_id, template_version_id, kind, id_map) values ($1, $2, $3, $4, $5, 'form', '{}')`,
        [bindingId, b.orgId, b.formIds[1], b.tpl.orgTemplateId, b.tpl.orgV1Id],
      );
      const repoint = (ctx: Ctx) => run(ctx, (tx) => tx.execute(sql`update form_template_bindings set template_version_id = ${b.tpl.orgDraftId} where id = ${bindingId}`));
      expect(pgCode(await failure(repoint(viewerB())))).toBe('23503');
      const touched = await run(viewerB(), (tx) => tx.execute(sql`update form_template_bindings set update_state = 'available' where id = ${bindingId}`));
      expect(touched.rowCount).toBe(1);
      expect((await repoint(ownerB())).rowCount).toBe(1);
    });

    it('diff: template_for_binding returns a draft only to its author and the org’s reviewers', async () => {
      const b = seed.b;
      const [toSystem, toPersonal] = [randomUUID(), randomUUID()];
      await t.owner.query(
        `insert into form_template_bindings (id, org_id, form_id, template_id, template_version_id, kind, id_map)
         values ($1, $2, $3, $4, $5, 'form', '{}'), ($6, $2, $3, $7, $8, 'form', '{}')`,
        [toSystem, b.orgId, b.formIds[1], hidden.systemTemplateId, hidden.systemReviewId, toPersonal, hidden.personalTemplateId, hidden.personalDraftId],
      );
      for (const ctx of [viewerB(), ownerB(), apiKeyB(), systemB()]) {
        expect(await run(ctx, (tx) => templateForBinding(tx, toSystem)), ctx.actor).toBeNull();
      }
      for (const ctx of [viewerB(), apiKeyB(), systemB()]) {
        expect(await run(ctx, (tx) => templateForBinding(tx, toPersonal)), ctx.actor).toBeNull();
      }
      expect(await run(editorB(), (tx) => templateForBinding(tx, toPersonal))).toMatchObject({ state: 'draft', templateVersionId: hidden.personalDraftId });
      expect(await run(ownerB(), (tx) => templateForBinding(tx, toPersonal))).toMatchObject({ state: 'draft' });
    });

    it('fork: neither a template nor a fork binding derives from a version the caller cannot read', async () => {
      const b = seed.b;
      for (const [templateId, versionId] of invisible()) {
        const fork = run(viewerB(), (tx) =>
          tx.execute(sql`insert into templates (id, org_id, scope, kind, slug, source, forked_from_version_id, created_by)
                         values (${randomUUID()}, ${b.orgId}, 'org', 'form', ${`fork-${randomUUID().slice(0, 8)}`}, 'fork', ${versionId}, ${b.viewerId})`),
        );
        expect(pgCode(await failure(fork)), versionId).toBe('23503');
        const upstream = run(viewerB(), (tx) =>
          tx.execute(sql`insert into template_fork_bindings (id, org_id, template_id, upstream_template_id, upstream_version_id, id_map)
                         values (${randomUUID()}, ${b.orgId}, ${b.tpl.forkTemplateId}, ${templateId}, ${versionId}, '{}')`),
        );
        expect(pgCode(await failure(upstream)), versionId).toBe('23503');
      }
      const forkBindingId = randomUUID();
      await t.owner.query(
        `insert into template_fork_bindings (id, org_id, template_id, upstream_template_id, upstream_version_id, id_map) values ($1, $2, $3, $4, $5, '{}')`,
        [forkBindingId, b.orgId, b.tpl.forkTemplateId, b.tpl.orgTemplateId, b.tpl.orgV1Id],
      );
      const repoint = (ctx: Ctx) => run(ctx, (tx) => tx.execute(sql`update template_fork_bindings set upstream_version_id = ${b.tpl.orgDraftId} where id = ${forkBindingId}`));
      expect(pgCode(await failure(repoint(viewerB())))).toBe('23503');
      expect((await repoint(ownerB())).rowCount).toBe(1);
    });
  });

  it('fork: a template may fork a system version or one of the org, never another org’s', async () => {
    const insertFork = (forkedFrom: string) =>
      run(editorB(), (tx) =>
        tx.execute(sql`insert into templates (id, org_id, scope, kind, slug, source, forked_from_version_id, created_by)
                       values (${randomUUID()}, ${seed.b.orgId}, 'org', 'form', ${`fork-${randomUUID().slice(0, 8)}`}, 'fork', ${forkedFrom}, ${seed.b.editorId})`),
      );
    await insertFork(seed.system.versionId);
    await insertFork(seed.b.tpl.orgV1Id);
    expect(pgCode(await failure(insertFork(seed.a.tpl.orgV1Id)))).toBe('23503');
    const forkBinding = (upstreamTemplateId: string, upstreamVersionId: string) =>
      run(editorB(), (tx) =>
        tx.execute(sql`insert into template_fork_bindings (id, org_id, template_id, upstream_template_id, upstream_version_id, id_map)
                       values (${randomUUID()}, ${seed.b.orgId}, ${seed.b.tpl.forkTemplateId}, ${upstreamTemplateId}, ${upstreamVersionId}, '{}')`),
      );
    expect(pgCode(await failure(forkBinding(seed.a.tpl.orgTemplateId, seed.a.tpl.orgV1Id)))).toBe('23503');
    expect(pgCode(await failure(forkBinding(seed.system.templateId, seed.a.tpl.orgV1Id)))).toBe('23503');
    // The fork itself must be the org's.
    const err = await failure(
      run(editorB(), (tx) =>
        tx.execute(sql`insert into template_fork_bindings (id, org_id, template_id, upstream_template_id, upstream_version_id, id_map)
                       values (${randomUUID()}, ${seed.b.orgId}, ${seed.a.tpl.forkTemplateId}, ${seed.system.templateId}, ${seed.system.versionId}, '{}')`),
      ),
    );
    expect(pgCode(err)).toBe('23503');
  });

  it('export: another org’s payloads, localizations and categories cannot be read', async () => {
    const a = seed.a.tpl;
    const exported = await run(ownerB(), async (tx) => ({
      payloads: (await tx.execute(sql`select payload from template_versions where template_id = ${a.orgTemplateId}`)).rows.length,
      titles: (await tx.execute(sql`select title from template_localizations where template_version_id = ${a.orgV1Id}`)).rows.length,
      categories: (await tx.execute(sql`select 1 from template_categories where id = ${a.categoryId}`)).rows.length,
      kits: (await tx.execute(sql`select 1 from brand_kits where id = ${a.kitId}`)).rows.length,
      bindings: (await tx.execute(sql`select 1 from form_template_bindings where id = ${a.bindingId}`)).rows.length,
      forks: (await tx.execute(sql`select 1 from template_fork_bindings where id = ${a.forkBindingId}`)).rows.length,
    }));
    expect(exported).toEqual({ payloads: 0, titles: 0, categories: 0, kits: 0, bindings: 0, forks: 0 });
  });

  it('references to another org’s category, parent category or brand kit are refused', async () => {
    const b = seed.b;
    const link = (categoryId: string) =>
      run(ownerB(), (tx) => tx.execute(sql`insert into template_category_links (template_id, category_id) values (${b.tpl.teamTemplateId}, ${categoryId})`));
    expect(pgCode(await failure(link(seed.a.tpl.categoryId)))).toBe('23503');
    const child = (parentId: string) =>
      run(ownerB(), (tx) =>
        tx.execute(sql`insert into template_categories (id, org_id, facet, parent_id, slug, names)
                       values (${randomUUID()}, ${b.orgId}, 'industry', ${parentId}, ${`c-${randomUUID().slice(0, 8)}`}, '{}')`),
      );
    await child(seed.system.categoryId);
    expect(pgCode(await failure(child(seed.a.tpl.categoryId)))).toBe('23503');
    const kit = await failure(run(editorB(), (tx) => tx.execute(sql`update forms set brand_kit_id = ${seed.a.tpl.kitId} where id = ${b.formIds[0]}`)));
    expect(pgCode(kit)).toBe('23503');
    await run(editorB(), (tx) => tx.execute(sql`update forms set brand_kit_id = ${b.tpl.kitId} where id = ${b.formIds[0]}`));
  });
});

describe('system rows', () => {
  it('fr_app cannot write them, in any actor kind', async () => {
    const s = seed.system;
    for (const ctx of [ownerB(), apiKeyB(), systemB()]) {
      const insert = (q: SQL) => failure(run(ctx, (tx) => tx.execute(q)));
      expect(
        pgCode(await insert(sql`insert into templates (id, scope, kind, publisher, slug, source) values (${randomUUID()}, 'system', 'form', 'fORM-', 'core/x', 'system_pack')`)),
        ctx.actor,
      ).toBe('42501');
      expect(
        pgCode(
          await insert(
            sql`insert into template_versions (id, template_id, version, schema_version, payload, payload_hash) values (${randomUUID()}, ${s.templateId}, 2, 1, '{}', ${HASH})`,
          ),
        ),
      ).toBe('42501');
      expect(pgCode(await insert(sql`insert into template_localizations (template_version_id, locale, title, summary) values (${s.versionId}, 'hi-IN', 'x', 'x')`))).toBe(
        '42501',
      );
      expect(
        pgCode(await insert(sql`insert into template_categories (id, facet, slug, names) values (${randomUUID()}, 'industry', ${`x-${randomUUID().slice(0, 6)}`}, '{}')`)),
      ).toBe('42501');
      expect(pgCode(await insert(sql`insert into template_signing_keys (id, key_id, public_key, alg) values (${randomUUID()}, ${`fORM-k-${randomUUID()}`}, ${HASH}, 'ed25519')`))).toBe('42501');
      expect(pgCode(await insert(sql`insert into template_search_synonyms (term, expands_to) values ('x', '{y}')`))).toBe('42501');
      expect(pgCode(await insert(sql`insert into template_packs (id, publisher, name, version, manifest, manifest_hash, verification) values (${randomUUID()}, 'x', 'x', '1', '{}', ${HASH}, 'verified')`))).toBe(
        '42501',
      );
      const changed = await run(ctx, async (tx) => ({
        templates: (await tx.execute(sql`update templates set featured = true where id = ${s.templateId}`)).rowCount,
        versions: (await tx.execute(sql`update template_versions set thumbnail_asset_id = ${randomUUID()} where id = ${s.versionId}`)).rowCount,
        deletedVersions: (await tx.execute(sql`delete from template_versions where id = ${s.versionId}`)).rowCount,
        localizations: (await tx.execute(sql`update template_localizations set title = 'x' where template_version_id = ${s.versionId}`)).rowCount,
        categories: (await tx.execute(sql`update template_categories set sort = 9 where id = ${s.categoryId}`)).rowCount,
        deletedCategories: (await tx.execute(sql`delete from template_categories where id = ${s.categoryId}`)).rowCount,
        links: (await tx.execute(sql`delete from template_category_links where template_id = ${s.templateId}`)).rowCount,
        keys: (await tx.execute(sql`update template_signing_keys set revoked_at = now() where key_id = ${s.keyId}`)).rowCount,
        deleted: await deleteTemplate(tx, s.templateId),
      }));
      expect(changed, ctx.actor).toEqual({
        templates: 0,
        versions: 0,
        deletedVersions: 0,
        localizations: 0,
        categories: 0,
        deletedCategories: 0,
        links: 0,
        keys: 0,
        deleted: false,
      });
    }
  });

  it('cannot be pointed at from an org template as its current version', async () => {
    const err = await failure(run(ownerB(), (tx) => tx.execute(sql`update templates set current_version_id = ${seed.system.versionId} where id = ${seed.b.tpl.orgTemplateId}`)));
    expect(pgCode(err)).toBe('23503');
  });
});

describe('fr_template_seeder', () => {
  it('writes a system template with its version, localization, category and link in one transaction', async () => {
    const c = await seeder.connect();
    const id = randomUUID();
    const versionId = randomUUID();
    const categoryId = randomUUID();
    try {
      await c.query('begin');
      await c.query(
        `insert into templates (id, scope, kind, publisher, slug, source, pack_id, current_version_id) values ($1, 'system', 'form', 'fORM-', $2, 'system_pack', $3, $4)`,
        [id, `core/seeded-${id.slice(0, 8)}`, seed.system.packId, versionId],
      );
      await c.query(
        `insert into template_versions (id, template_id, version, state, schema_version, payload, payload_hash, published_at) values ($1, $2, 1, 'published', 1, '{}', $3, now())`,
        [versionId, id, HASH],
      );
      await c.query(`insert into template_localizations (template_version_id, locale, title, summary) values ($1, 'hi-IN', 'विक्रेता', 'सारांश')`, [versionId]);
      await c.query(`insert into template_categories (id, facet, slug, names) values ($1, 'compliance', $2, '{"en-IN":"DPDP"}')`, [categoryId, `dpdp-${id.slice(0, 8)}`]);
      await c.query('insert into template_category_links (template_id, category_id) values ($1, $2)', [id, categoryId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const { rows } = await t.owner.query('select org_id from template_localizations where template_version_id = $1', [versionId]);
    expect(rows).toEqual([{ org_id: null }]);
    expect(await visibleTemplates(viewerB())).toContain(id);
  });

  it('sees no org rows and can write none', async () => {
    const counts = await seeder.query<{ templates: number; versions: number; localizations: number; links: number; categories: number; packs: number; keys: number }>(
      `select (select count(*)::int from templates where org_id is not null) as templates,
              (select count(*)::int from template_versions where org_id is not null) as versions,
              (select count(*)::int from template_localizations where org_id is not null) as localizations,
              (select count(*)::int from template_category_links where org_id is not null) as links,
              (select count(*)::int from template_categories where org_id is not null) as categories,
              (select count(*)::int from template_packs where org_id is not null) as packs,
              (select count(*)::int from template_signing_keys where org_id is not null) as keys`,
    );
    expect(counts.rows[0]).toEqual({ templates: 0, versions: 0, localizations: 0, links: 0, categories: 0, packs: 0, keys: 0 });
    const b = seed.b;
    const refused = async (text: string, values: unknown[]) => pgCode(await failure(seeder.query(text, values)));
    expect(
      await refused(`insert into templates (id, org_id, scope, kind, slug, source) values ($1, $2, 'org', 'form', 'seeded', 'system_pack')`, [randomUUID(), b.orgId]),
    ).toBe('42501');
    // Attaching a system-looking row to an org's template: the trigger gives it the template's org.
    expect(
      await refused(`insert into template_versions (id, template_id, version, schema_version, payload, payload_hash) values ($1, $2, 7, 1, '{}', $3)`, [
        randomUUID(),
        b.tpl.orgTemplateId,
        HASH,
      ]),
    ).toBe('42501');
    expect(await refused(`insert into template_localizations (template_version_id, locale, title, summary) values ($1, 'ta-IN', 'x', 'x')`, [b.tpl.orgV1Id])).toBe('42501');
    expect(await refused('insert into template_category_links (template_id, category_id) values ($1, $2)', [b.tpl.teamTemplateId, seed.system.categoryId])).toBe('42501');
    expect(await refused('insert into template_category_links (template_id, category_id) values ($1, $2)', [seed.system.templateId, b.tpl.categoryId])).toBe('23503');
    expect((await seeder.query('update templates set featured = true where org_id = $1', [b.orgId])).rowCount).toBe(0);
    expect((await seeder.query(`update template_versions set changelog = 'x' where org_id = $1`, [b.orgId])).rowCount).toBe(0);
    expect(await refused('delete from template_versions where id = $1', [seed.system.versionId])).toBe('42501');
    for (const table of ['brand_kits', 'form_template_bindings', 'template_fork_bindings', 'template_usages', 'template_stats_daily', 'template_search_misses', 'forms', 'orgs']) {
      expect(await refused(`select 1 from ${table}`, []), table).toBe('42501');
    }
  });
});

describe('immutable versions (templates spec §2.2)', () => {
  async function freshTemplate(): Promise<string> {
    const id = randomUUID();
    await insertTemplate(t.owner, { id, orgId: seed.b.orgId, scope: 'org', slug: `imm-${id.slice(0, 8)}`, createdBy: seed.b.ownerId });
    return id;
  }

  it('refuse any change to payload, hash or fingerprints once published, for every role', async () => {
    const templateId = await freshTemplate();
    const v1 = randomUUID();
    await insertVersion(t.owner, { id: v1, templateId, version: 1, state: 'published', createdBy: seed.b.ownerId, title: 'Immutable' });
    for (const set of [`payload = '{"kind":"form","x":1}'`, `payload_hash = '\\x${'11'.repeat(32)}'`, `lock_fingerprints = '{"l1":"x"}'`, 'schema_version = 2']) {
      expect(pgCode(await failure(t.owner.query(`update template_versions set ${set} where id = $1`, [v1]))), set).toBe('42501');
    }
    expect(pgCode(await failure(run(ownerB(), (tx) => tx.execute(sql`update template_versions set payload = '{}' where id = ${v1}`))))).toBe('42501');
    expect(pgCode(await failure(t.owner.query(`update template_versions set version = 5 where id = $1`, [v1])))).toBe('42501');
    // Operational columns stay writable: thumbnails, stats, review notes.
    await run(ownerB(), (tx) => tx.execute(sql`update template_versions set thumbnail_asset_id = ${randomUUID()}, stats_fields = 4 where id = ${v1}`));
    expect(pgCode(await failure(run(ownerB(), (tx) => tx.execute(sql`delete from template_versions where id = ${v1}`))))).toBe('42501');
  });

  it('move only along the lifecycle; superseded and rejected are terminal', async () => {
    const templateId = await freshTemplate();
    const [v1, v2, v3] = [randomUUID(), randomUUID(), randomUUID()];
    await insertVersion(t.owner, { id: v1, templateId, version: 1, state: 'published', createdBy: seed.b.ownerId, title: 'Life v1' });
    await insertVersion(t.owner, { id: v2, templateId, version: 2, state: 'draft', createdBy: seed.b.ownerId, title: 'Life v2' });
    const owner = ownerB();
    const state = (id: string, to: string) => run(owner, (tx) => tx.execute(sql`update template_versions set state = ${to}::template_version_state where id = ${id}`));
    // Drafts are edited freely, and cannot be rejected without review.
    await run(owner, (tx) => tx.execute(sql`update template_versions set payload = '{"kind":"form","edited":true}', changelog = 'Edited' where id = ${v2}`));
    expect(pgCode(await failure(state(v2, 'rejected')))).toBe('23514');
    await state(v2, 'in_review');
    expect(pgCode(await failure(run(owner, (tx) => tx.execute(sql`update template_versions set payload = '{}' where id = ${v2}`))))).toBe('42501');
    expect(pgCode(await failure(state(v2, 'draft')))).toBe('23514');
    // One published version per template: supersede first.
    expect(pgCode(await failure(state(v2, 'published')))).toBe('23505');
    await state(v1, 'superseded');
    await state(v2, 'published');
    expect(pgCode(await failure(state(v1, 'published')))).toBe('23514');
    await insertVersion(t.owner, { id: v3, templateId, version: 3, state: 'draft', createdBy: seed.b.ownerId, title: 'Life v3' });
    await state(v3, 'in_review');
    await state(v3, 'rejected');
    expect(pgCode(await failure(state(v3, 'in_review')))).toBe('23514');
    expect(pgCode(await failure(run(owner, (tx) => tx.execute(sql`update template_versions set payload = '{}' where id = ${v3}`))))).toBe('42501');
  });

  it('past draft, change state or the mandatory flag only for reviewers, govern holders and jobs', async () => {
    const templateId = await freshTemplate();
    const v1 = randomUUID();
    await insertVersion(t.owner, { id: v1, templateId, version: 1, state: 'published', createdBy: seed.b.editorId, title: 'Gallery item' });
    const set = (ctx: Ctx, change: SQL) => run(ctx, (tx) => tx.execute(sql`update template_versions set ${change} where id = ${v1}`));
    for (const change of [sql`state = 'superseded'`, sql`mandatory = true`, sql`mandatory_deadline = now()`]) {
      expect(pgCode(await failure(set(editorB(), change)))).toBe('42501');
      expect(pgCode(await failure(set(apiKeyB(), change)))).toBe('42501');
    }
    expect((await set(editorB(), sql`changelog = 'Notes'`)).rowCount).toBe(1);
    expect((await set(systemB(), sql`mandatory = true`)).rowCount).toBe(1);
    expect((await set({ ...editorB(), perms: ['templates.govern'] }, sql`mandatory_deadline = now()`)).rowCount).toBe(1);
    expect((await set({ ...editorB(), perms: ['templates.approve'] }, sql`state = 'superseded'`)).rowCount).toBe(1);
  });

  it('keep one draft per template, and drafts can be discarded', async () => {
    const templateId = await freshTemplate();
    const draft = randomUUID();
    await insertVersion(t.owner, { id: draft, templateId, version: 1, state: 'draft', createdBy: seed.b.ownerId, title: 'Draft one' });
    const second = failure(
      t.owner.query(`insert into template_versions (id, template_id, version, schema_version, payload, payload_hash) values ($1, $2, 2, 1, '{}', $3)`, [
        randomUUID(),
        templateId,
        HASH,
      ]),
    );
    expect(pgCode(await second)).toBe('23505');
    await run(ownerB(), async (tx) => {
      await tx.execute(sql`delete from template_localizations where template_version_id = ${draft}`);
      expect((await tx.execute(sql`delete from template_versions where id = ${draft}`)).rowCount).toBe(1);
    });
  });
});

describe('templates and versions', () => {
  it('are created together under the deferred cycle, and a current version must be the template’s own', async () => {
    const id = randomUUID();
    const versionId = randomUUID();
    await run(editorB(), async (tx) => {
      await tx.execute(sql`insert into templates (id, org_id, scope, kind, slug, source, current_version_id, created_by)
                           values (${id}, ${seed.b.orgId}, 'org', 'form', ${`pair-${id.slice(0, 8)}`}, 'user', ${versionId}, ${seed.b.editorId})`);
      await tx.execute(sql`insert into template_versions (id, template_id, version, state, schema_version, payload, payload_hash, created_by)
                           values (${versionId}, ${id}, 1, 'published', 1, '{}', ${HASH}, ${seed.b.editorId})`);
    });
    const { rows } = await t.owner.query('select org_id from template_versions where id = $1', [versionId]);
    expect(rows).toEqual([{ org_id: seed.b.orgId }]);
    const err = await failure(run(editorB(), (tx) => tx.execute(sql`update templates set current_version_id = ${seed.b.tpl.orgV1Id} where id = ${id}`)));
    expect(pgCode(err)).toBe('23503');
  });

  it('have publisher-scoped slugs, unique per org or among system rows, freed by deletion', async () => {
    const slug = seed.system.slug;
    // The same slug in an org is fine; a second system row with it is not.
    await insertTemplate(t.owner, { id: randomUUID(), orgId: seed.b.orgId, scope: 'org', slug, createdBy: seed.b.ownerId });
    expect(pgCode(await failure(insertTemplate(t.owner, { id: randomUUID(), orgId: null, scope: 'system', slug, createdBy: null })))).toBe('23505');
    const id = randomUUID();
    const mine = `mine-${id.slice(0, 8)}`;
    await insertTemplate(t.owner, { id, orgId: seed.b.orgId, scope: 'personal', slug: mine, ownerUserId: seed.b.editorId, createdBy: seed.b.editorId });
    expect(pgCode(await failure(insertTemplate(t.owner, { id: randomUUID(), orgId: seed.b.orgId, scope: 'org', slug: mine, createdBy: seed.b.ownerId })))).toBe('23505');
    // A peer cannot delete another member's personal template; its owner can.
    expect(await run(viewerB(), (tx) => deleteTemplate(tx, id))).toBe(false);
    expect(pgCode(await failure(run(respondentB(), (tx) => deleteTemplate(tx, id))))).toBe('42501');
    expect(await run(editorB(), (tx) => deleteTemplate(tx, id))).toBe(true);
    expect(await run(editorB(), (tx) => deleteTemplate(tx, id))).toBe(false);
    await insertTemplate(t.owner, { id: randomUUID(), orgId: seed.b.orgId, scope: 'org', slug: mine, createdBy: seed.b.ownerId });
  });

  it('a personal template is its creator’s: a peer cannot create one for someone else', async () => {
    const personal = (ctx: Ctx, ownerUserId: string) =>
      run(ctx, (tx) =>
        tx.execute(sql`insert into templates (id, org_id, owner_user_id, scope, kind, slug, source)
                       values (${randomUUID()}, ${seed.b.orgId}, ${ownerUserId}, 'personal', 'form', ${`p-${randomUUID().slice(0, 8)}`}, 'user')`),
      );
    await personal(editorB(), seed.b.editorId);
    expect(pgCode(await failure(personal(editorB(), seed.b.viewerId)))).toBe('42501');
    expect(pgCode(await failure(personal(apiKeyB(), seed.b.viewerId)))).toBe('42501');
    await personal(ownerB(), seed.b.viewerId);
  });

  it('a team template goes only to a team of the member, unless they hold templates.govern', async () => {
    const team = (ctx: Ctx, teamId: string) =>
      run(ctx, (tx) =>
        tx.execute(sql`insert into templates (id, org_id, team_id, scope, kind, slug, source)
                       values (${randomUUID()}, ${seed.b.orgId}, ${teamId}, 'team', 'form', ${`t-${randomUUID().slice(0, 8)}`}, 'user')`),
      );
    const otherTeam = randomUUID();
    await team(editorB(), seed.b.teamId);
    expect(pgCode(await failure(team(editorB(), otherTeam)))).toBe('42501');
    expect(pgCode(await failure(team(apiKeyB(), seed.b.teamId)))).toBe('42501');
    await team({ ...ownerB(), teamIds: [] }, otherTeam);
    const id = randomUUID();
    await insertTemplate(t.owner, { id, orgId: seed.b.orgId, scope: 'org', slug: `move-${id.slice(0, 8)}`, createdBy: seed.b.ownerId });
    const move = (ctx: Ctx, teamId: string) => run(ctx, (tx) => tx.execute(sql`update templates set scope = 'team', team_id = ${teamId} where id = ${id}`));
    expect(pgCode(await failure(move(editorB(), otherTeam)))).toBe('42501');
    const toPeer = run(editorB(), (tx) => tx.execute(sql`update templates set scope = 'personal', owner_user_id = ${seed.b.viewerId} where id = ${id}`));
    expect(pgCode(await failure(toPeer))).toBe('42501');
    expect((await move(editorB(), seed.b.teamId)).rowCount).toBe(1);
  });

  it('keep the scope shape', async () => {
    const bad = (scope: string, extra: SQL) =>
      failure(run(ownerB(), (tx) => tx.execute(sql`insert into templates (id, org_id, scope, kind, slug, source, team_id, owner_user_id)
                                                     values (${randomUUID()}, ${seed.b.orgId}, ${scope}::template_scope, 'form', 'x', 'user', ${extra})`)));
    expect(pgCode(await bad('team', sql`null, null`))).toBe('23514');
    expect(pgCode(await bad('personal', sql`null, null`))).toBe('23514');
    expect(pgCode(await bad('org', sql`${seed.b.teamId}, null`))).toBe('23514');
  });
});

describe('template_stats_daily', () => {
  it('shows the org its own figures and a system template’s only from 5 distinct orgs', async () => {
    const rows = await run(editorB(), async (tx) => (await tx.execute<{ org_id: string | null; distinct_orgs: number | null }>(sql`select org_id, distinct_orgs from template_stats_daily order by org_id nulls first`)).rows);
    expect(rows).toEqual([
      { org_id: null, distinct_orgs: 7 },
      { org_id: seed.b.orgId, distinct_orgs: null },
    ]);
  });

  it('is written by fr_system_agg, which reads the sources but no payloads', async () => {
    await agg.query(
      `insert into template_stats_daily (template_id, day, org_id, uses) values ($1, current_date, $2, 1)
       on conflict (template_id, day, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set uses = excluded.uses + 1`,
      [seed.b.tpl.orgTemplateId, seed.b.orgId],
    );
    const { rows } = await agg.query<{ n: number }>('select count(distinct org_id)::int as n from template_usages');
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
    await agg.query('select id, org_id, scope, kind from templates');
    await agg.query('select org_id, template_id, template_version_id from form_template_bindings');
    for (const q of ['select slug from templates', 'select payload from template_versions', 'select title from template_localizations', 'select tokens from brand_kits']) {
      expect(pgCode(await failure(agg.query(q))), q).toBe('42501');
    }
    expect(pgCode(await failure(run(ownerB(), (tx) => tx.execute(sql`insert into template_stats_daily (template_id, day, org_id) values (${seed.b.tpl.orgTemplateId}, current_date, ${seed.b.orgId})`))))).toBe(
      '42501',
    );
  });
});

describe('template_usages', () => {
  it('is append-only, also for the owner role', async () => {
    expect(pgCode(await failure(t.owner.query('update template_usages set locale = $1 where org_id = $2', ['hi-IN', seed.b.orgId])))).toBe('42501');
    expect(pgCode(await failure(t.owner.query('delete from template_usages where org_id = $1', [seed.b.orgId])))).toBe('42501');
    await run(apiKeyB(), (tx) =>
      tx.execute(sql`insert into template_usages (org_id, template_id, template_version_id, action) values (${seed.b.orgId}, ${seed.system.templateId}, ${seed.system.versionId}, 'preview')`),
    );
  });

  it('names a system template or one of the org, with a version of that template', async () => {
    const usage = (templateId: string, versionId: string) =>
      run(apiKeyB(), (tx) =>
        tx.execute(sql`insert into template_usages (org_id, template_id, template_version_id, action) values (${seed.b.orgId}, ${templateId}, ${versionId}, 'preview')`),
      );
    await usage(seed.b.tpl.orgTemplateId, seed.b.tpl.orgV1Id);
    expect(pgCode(await failure(usage(seed.a.tpl.orgTemplateId, seed.a.tpl.orgV1Id)))).toBe('23503');
    expect(pgCode(await failure(usage(seed.system.templateId, seed.b.tpl.orgV1Id)))).toBe('23503');
    expect(pgCode(await failure(usage(randomUUID(), seed.system.versionId)))).toBe('23503');
  });

  it('lets the retention sweep delete rows past the 400-day TTL, and nothing else', async () => {
    const formId = randomUUID();
    await t.owner.query(
      `insert into template_usages (org_id, template_id, template_version_id, action, form_id, occurred_at)
       values ($1, $2, $3, 'preview', $4, now() - interval '401 days'), ($1, $2, $3, 'preview', $4, now() - interval '399 days')`,
      [seed.b.orgId, seed.system.templateId, seed.system.versionId, formId],
    );
    expect(pgCode(await failure(t.owner.query('update template_usages set locale = $1 where form_id = $2', ['hi-IN', formId])))).toBe('42501');
    expect(pgCode(await failure(t.owner.query('delete from template_usages where form_id = $1', [formId])))).toBe('42501');
    const swept = await t.owner.query(`delete from template_usages where form_id = $1 and occurred_at < now() - interval '400 days'`, [formId]);
    expect(swept.rowCount).toBe(1);
    expect(pgCode(await failure(run(ownerB(), (tx) => tx.execute(sql`delete from template_usages where form_id = ${formId}`))))).toBe('42501');
  });
});

describe('template_signing_keys', () => {
  const key = (ctx: Ctx, keyId: string) =>
    run(ctx, (tx) =>
      tx.execute(sql`insert into template_signing_keys (id, key_id, org_id, public_key, alg, label) values (${randomUUID()}, ${keyId}, ${seed.b.orgId}, ${HASH}, 'ed25519', 'org')`),
    );
  const orgsOf = (ctx: Ctx, keyId: string) =>
    run(ctx, async (tx) => (await tx.execute<{ org_id: string | null }>(sql`select org_id from template_signing_keys where key_id = ${keyId}`)).rows);

  it('reserves the fORM- namespace for platform keys, so no tenant can squat or shadow a release key', async () => {
    const release = `fORM-release-${randomUUID().slice(0, 8)}`;
    for (const keyId of [release, release.toLowerCase(), 'FORM-x']) {
      expect(pgCode(await failure(key(ownerB(), keyId))), keyId).toBe('23514');
    }
    await seeder.query(`insert into template_signing_keys (id, key_id, public_key, alg, label) values ($1, $2, $3, 'ed25519', 'release')`, [randomUUID(), release, HASH]);
    const unprefixed = seeder.query(`insert into template_signing_keys (id, key_id, public_key, alg) values ($1, 'acme-legal', $2, 'ed25519')`, [randomUUID(), HASH]);
    expect(pgCode(await failure(unprefixed))).toBe('23514');
    expect(await orgsOf(editorB(), release)).toEqual([{ org_id: null }]);
  });

  it('keeps key ids unique per org: another org’s id is free to use and its existence does not show', async () => {
    const theirs = seed.a.tpl.keyId;
    expect((await key(ownerB(), theirs)).rowCount).toBe(1);
    expect(await orgsOf(ownerB(), theirs)).toEqual([{ org_id: seed.b.orgId }]);
    expect(pgCode(await failure(key(ownerB(), theirs)))).toBe('23505');
    const { rows } = await t.owner.query('select count(*)::int as n from template_signing_keys where key_id = $1', [theirs]);
    expect(rows).toEqual([{ n: 2 }]);
  });
});
