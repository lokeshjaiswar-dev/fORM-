import { Extension, Mark, Node, type AnyExtension, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { ThemeColorTokenSchema, isSafeHref, tokenVar } from '@form/schema';
import { LINK_REL } from '@form/renderer';
import { clipboardContent } from '@/components/editor/paste';

export type EditorKind = 'inline' | 'rich';

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** CSS for a stored `ColorValue`; tokens render through the theme's custom properties. */
export function colorCss(value: unknown): string | undefined {
  if (typeof value === 'string') return HEX.test(value) ? value : undefined;
  if (typeof value !== 'object' || value === null || !('token' in value)) return undefined;
  const token = ThemeColorTokenSchema.safeParse(value.token);
  return token.success ? `var(${tokenVar(token.data)})` : undefined;
}

const colorMark = (name: 'textColor' | 'highlight', property: 'color' | 'background-color') =>
  Mark.create({
    name,
    addAttributes() {
      return { color: { default: null, rendered: false } };
    },
    parseHTML() {
      return [];
    },
    renderHTML({ mark }) {
      const css = colorCss(mark.attrs.color);
      return ['span', css ? { style: `${property}: ${css}` } : {}, 0];
    },
  });

/** Plain `code` mark; StarterKit's excludes every other mark, which the AST allows. */
const Code = Mark.create({
  name: 'code',
  parseHTML() {
    return [];
  },
  renderHTML() {
    return ['code', 0];
  },
});

const Align = Extension.create({
  name: 'align',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        align: {
          default: null,
          parseHTML: () => null,
          renderHTML: (attrs: Record<string, unknown>) => (['left', 'center', 'right'].includes(String(attrs.align)) ? { style: `text-align: ${attrs.align}` } : {}),
        },
      },
    }];
  },
});

function chip(attrs: Record<string, unknown>, fallback: string): string {
  return typeof attrs.fallback === 'string' && attrs.fallback ? attrs.fallback : fallback;
}

/** Reserved for answer piping (PRE-02): kept intact in documents; there is no UI to insert one yet. */
const Pipe = Node.create({
  name: 'pipe',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return Object.fromEntries(['source', 'format', 'fallback', 'encode'].map((key) => [key, { default: null, rendered: false }]));
  },
  parseHTML() {
    return [];
  },
  renderHTML({ node }) {
    return ['span', { 'data-type': 'pipe', class: 'rounded bg-zinc-100 px-1 text-zinc-500' }, chip(node.attrs, 'answer')];
  },
  renderText({ node }) {
    return chip(node.attrs, '');
  },
});

/** Reserved for template variables (TPL): kept intact in documents; there is no UI to insert one yet. */
const Var = Node.create({
  name: 'var',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { name: { default: null, rendered: false }, fallback: { default: null, rendered: false } };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ node }) {
    return ['span', { 'data-type': 'var', class: 'rounded bg-zinc-100 px-1 text-zinc-500' }, `{${String(node.attrs.name)}}`];
  },
  renderText({ node }) {
    return chip(node.attrs, `{${String(node.attrs.name)}}`);
  },
});

/** Reserved for asset images: kept intact in documents and shown as a placeholder. */
const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  addAttributes() {
    return Object.fromEntries(['asset', 'widthPct', 'align', 'href'].map((key) => [key, { default: null, rendered: false }]));
  },
  parseHTML() {
    return [];
  },
  renderHTML() {
    return ['div', { 'data-type': 'image', class: 'rounded border border-dashed border-zinc-300 p-2 text-[12px] text-zinc-400' }, 'Image'];
  },
});

function insert(editor: Editor, content: JSONContent[], at?: number) {
  if (!content.length) return;
  if (at === undefined) editor.chain().focus().insertContent(content).run();
  else editor.chain().focus().insertContentAt(at, content).run();
}

/** Paste and external drops go through the `fromHtml` allowlist (paste profile); ProseMirror never parses the HTML. */
const SafePaste = Extension.create<{ kind: EditorKind }>({
  name: 'safePaste',
  addOptions() {
    return { kind: 'rich' };
  },
  addProseMirrorPlugins() {
    const { editor } = this;
    const { kind } = this.options;
    return [
      new Plugin({
        key: new PluginKey('safePaste'),
        props: {
          handleDOMEvents: {
            paste: (_view, event) => {
              const data = event.clipboardData;
              if (!data) return false;
              event.preventDefault();
              insert(editor, clipboardContent(data.getData('text/html'), data.getData('text/plain'), kind));
              return true;
            },
            drop: (view, event) => {
              const data = event.dataTransfer;
              if (view.dragging || !data) return false;
              event.preventDefault();
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
              insert(editor, clipboardContent(data.getData('text/html'), data.getData('text/plain'), kind), pos?.pos);
              return true;
            },
          },
        },
      }),
    ];
  },
});

export interface EditorHooks {
  /** Enter in a label; in rich text, Mod-Enter or Enter on an empty last paragraph. */
  onEnter: () => void;
}

const Keys = Extension.create<EditorHooks & { kind: EditorKind }>({
  name: 'formKeys',
  priority: 1000,
  addOptions() {
    return { kind: 'rich', onEnter: () => {} };
  },
  addKeyboardShortcuts() {
    const enter = () => {
      this.options.onEnter();
      return true;
    };
    if (this.options.kind === 'inline') return { Enter: enter, 'Mod-Enter': enter };
    return {
      'Mod-Enter': enter,
      Enter: ({ editor }) => {
        const { selection, doc } = editor.state;
        const { $from, empty } = selection;
        const lastEmpty = empty && $from.depth === 1 && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0
          && $from.index(0) === doc.childCount - 1;
        if (!lastEmpty) return false;
        if (doc.childCount > 1) editor.commands.command(({ tr }) => !!tr.delete($from.before(), $from.after()));
        return enter();
      },
    };
  },
});

/** The editor schema mirrors the AST: no node or mark exists here that `normalize` would drop. */
export function editorExtensions(kind: EditorKind, hooks: EditorHooks): AnyExtension[] {
  const rich = kind === 'rich';
  return [
    Node.create({ name: 'doc', topNode: true, content: rich ? 'block+' : 'paragraph' }),
    StarterKit.configure({
      document: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      blockquote: rich ? {} : false,
      bulletList: rich ? {} : false,
      orderedList: rich ? {} : false,
      listItem: rich ? {} : false,
      listKeymap: rich ? {} : false,
      horizontalRule: rich ? {} : false,
      heading: rich ? { levels: [1, 2, 3] } : false,
      link: {
        openOnClick: false,
        linkOnPaste: false,
        autolink: true,
        defaultProtocol: 'https',
        isAllowedUri: (url) => isSafeHref(url.trim()),
        shouldAutoLink: (url) => isSafeHref(url.trim()),
        HTMLAttributes: { rel: LINK_REL, target: '_blank', class: null },
      },
    }),
    Align,
    Code,
    colorMark('textColor', 'color'),
    colorMark('highlight', 'background-color'),
    Pipe,
    Var,
    ...(rich ? [Image] : []),
    SafePaste.configure({ kind }),
    Keys.configure({ kind, ...hooks }),
  ];
}
