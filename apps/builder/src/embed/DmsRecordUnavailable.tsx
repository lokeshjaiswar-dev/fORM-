/**
 * `/embed/dms-record` is a launch mode DMS+ may send (DESIGN section 5) but fORM- does not build it yet. A plain notice,
 * not a redirect to `/forms` (which would ask for a fORM- login). It reads no launch, calls nothing and has no authority.
 */
export function DmsRecordUnavailable() {
  return (
    <main className="mx-auto max-w-[720px] px-8 pt-[72px] text-foreground">
      <h1 className="text-[28px] font-bold">Editing a record is not available here yet</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">Go back to DMS and use the upload step to add or change records of this master.</p>
    </main>
  );
}
