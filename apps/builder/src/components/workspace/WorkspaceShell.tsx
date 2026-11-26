import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FileText, History, ShieldCheck } from 'lucide-react';
import { AppShell, AppShellHeader, AppShellMain, AppShellSidebar } from '@dmacq/ui/patterns';
import {
  Separator,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@dmacq/ui';
import { useRepository } from '@/persistence/repository';
import { whenSaved } from '@/persistence/autosave';
import type { FormSummary } from '@/persistence/DocumentRepository';
import { builderPath } from '@/pages/useBuilderMode';
import './workspace.css';

/** Brand mark: a rounded tile with a small animated form glyph drawn in SVG. */
function BrandMark() {
  return (
    <span className="ws-float flex size-8 items-center justify-center rounded-[9px] bg-primary text-primary-foreground shadow-sm">
      <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <rect x="3.5" y="2.5" width="13" height="15" rx="2.5" />
        <line x1="6.5" y1="7" x2="13.5" y2="7" />
        <line x1="6.5" y1="10.5" x2="13.5" y2="10.5" />
        <line x1="6.5" y1="14" x2="10.5" y2="14" />
      </svg>
    </span>
  );
}

const RECENT_COUNT = 6;

const mostRecent = (list: readonly FormSummary[]) => [...list].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)).slice(0, RECENT_COUNT);

interface WorkspaceShellProps {
  crumb: string;
  actions?: ReactNode;
  /**
   * The forms the page already holds (null while it loads them). Recent then follows that list, so a form the page
   * deletes, duplicates or drops as an empty draft changes the sidebar at once. Without it the shell loads its own.
   */
  forms?: readonly FormSummary[] | null;
  children: ReactNode;
}

/**
 * The frame for the forms workspace (`/forms`, `/forms/:id/responses`): a sidebar with sectioned navigation (workspace,
 * recent forms), a top bar with the breadcrumb and page actions, and a scrolling main area. Built on the dMACQ app shell.
 */
export function WorkspaceShell({ crumb, actions, forms, children }: WorkspaceShellProps) {
  const { pathname } = useLocation();
  const repo = useRepository();
  const [loaded, setLoaded] = useState<FormSummary[]>([]);
  const fromPage = forms !== undefined;
  const recent = useMemo(() => (fromPage ? mostRecent(forms ?? []) : loaded), [fromPage, forms, loaded]);
  const onForms = pathname === '/forms' || pathname.startsWith('/forms/');
  const activeId = /^\/builder\/([^/]+)/.exec(pathname)?.[1] ?? /^\/forms\/([^/]+)/.exec(pathname)?.[1];

  // A page that does not pass its forms: reload on every navigation so Recent follows edits, creations and deletions.
  useEffect(() => {
    if (fromPage) return;
    let live = true;
    whenSaved()
      .then(() => repo.list())
      .then((list) => {
        if (live) setLoaded(mostRecent(list));
      })
      .catch(() => live && setLoaded([]));
    return () => {
      live = false;
    };
  }, [repo, pathname, fromPage]);

  return (
    <AppShell className="h-svh">
      <AppShellSidebar label="Form+ navigation">
        <SidebarHeader>
          <div className="ws-sidebar-section flex items-center gap-2.5 px-2 py-2">
            <BrandMark />
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-[14px] font-semibold leading-tight">Form+</p>
              <p className="truncate text-[12px] text-muted-foreground">dMACQ Forms</p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={onForms && !activeId} tooltip="All forms">
                    <Link to="/forms">
                      <FileText />
                      <span className="group-data-[collapsible=icon]:hidden">All forms</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Recent</SidebarGroupLabel>
            <SidebarGroupContent>
              {recent.length === 0 ? (
                <p className="px-2 text-[12px] text-muted-foreground">Forms you open appear here.</p>
              ) : (
                <SidebarMenu>
                  {recent.map((form, i) => (
                    <SidebarMenuItem key={form.id} className="ws-row" style={{ ['--ws-delay' as string]: `${i * 35}ms` }}>
                      <SidebarMenuButton asChild isActive={activeId === form.id} tooltip={form.title || 'Untitled form'}>
                        <Link to={builderPath(form.id)}>
                          <span className="size-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
                          <span className="truncate">{form.title || 'Untitled form'}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <Separator className="mb-2" />
          <div className="flex items-center gap-2 px-2 pb-1 text-[12px] text-muted-foreground group-data-[collapsible=icon]:hidden">
            <span className="relative flex size-2">
              <span className="ws-live absolute inline-flex size-full rounded-full bg-primary" aria-hidden />
              <span className="relative inline-flex size-2 rounded-full bg-primary" aria-hidden />
            </span>
            <span className="truncate">Saved in this browser</span>
            <ShieldCheck className="ml-auto size-3.5 shrink-0" aria-hidden />
          </div>
        </SidebarFooter>
      </AppShellSidebar>

      <AppShellHeader>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          <History className="size-3.5 shrink-0" aria-hidden />
          <Link to="/forms" className="hover:text-foreground">
            Forms
          </Link>
          <span aria-hidden>/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {crumb}
          </span>
        </nav>
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </AppShellHeader>

      <AppShellMain maxWidth="none" contentClassName="ws-enter">
        {children}
      </AppShellMain>
    </AppShell>
  );
}
