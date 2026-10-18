import { Fragment, type CSSProperties, type ReactNode } from 'react';
import {
  ThemeColorTokenSchema, isSafeHref, isSafeUrl, normalizeInlineDoc, tokenVar,
  type AssetRef, type BrandRef, type ColorValue, type InlineDoc, type InlineNode, type ListItemNode, type Mark, type PipeAttrs,
  type RichBlockNode, type RichDoc, type VarNode,
} from '@form/schema';

export const LINK_REL = 'noopener noreferrer nofollow';

export interface RichTextResolvers {
  /** Live value of an answer pipe; the fallback is shown when this is absent or returns nothing. */
  pipe?: (attrs: PipeAttrs) => string | undefined;
  /** Value of a template variable (drafts and template previews only). */
  var?: (attrs: VarNode['attrs']) => string | undefined;
  /** CSS colour for a brand reference; hex and theme tokens resolve without it. */
  brand?: (ref: BrandRef) => string | undefined;
  /** URL of an image asset; images without one are not rendered. */
  asset?: (asset: AssetRef | BrandRef) => string | undefined;
}

export interface RichTextViewProps {
  doc: RichDoc | InlineDoc;
  /** Render the content of a single paragraph without a block wrapper (labels, headings). */
  inline?: boolean;
  resolve?: RichTextResolvers;
}

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function cssColor(value: ColorValue, resolve: RichTextResolvers | undefined): string | undefined {
  if (typeof value === 'string') return HEX.test(value) ? value : undefined;
  if ('token' in value) return ThemeColorTokenSchema.safeParse(value.token).success ? `var(${tokenVar(value.token)})` : undefined;
  return resolve?.brand?.(value);
}

function withMark(mark: Mark, child: ReactNode, key: number, resolve: RichTextResolvers | undefined): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong key={key}>{child}</strong>;
    case 'italic':
      return <em key={key}>{child}</em>;
    case 'underline':
      return <u key={key}>{child}</u>;
    case 'strike':
      return <s key={key}>{child}</s>;
    case 'code':
      return <code key={key}>{child}</code>;
    case 'link':
      return isSafeHref(mark.attrs.href)
        ? <a key={key} href={mark.attrs.href} rel={LINK_REL} target="_blank">{child}</a>
        : child;
    case 'textColor':
    case 'highlight': {
      const color = cssColor(mark.attrs.color, resolve);
      if (!color) return child;
      const style: CSSProperties = mark.type === 'textColor' ? { color } : { backgroundColor: color };
      return <span key={key} style={style}>{child}</span>;
    }
  }
}

function Inline({ nodes, resolve }: { nodes: readonly InlineNode[] | undefined; resolve: RichTextResolvers | undefined }) {
  return (nodes ?? []).map((node, i) => {
    switch (node.type) {
      case 'text':
        return (node.marks ?? []).reduceRight<ReactNode>((child, mark) => withMark(mark, child, i, resolve), <Fragment key={i}>{node.text}</Fragment>);
      case 'hardBreak':
        return <br key={i} />;
      case 'pipe':
        return <Fragment key={i}>{resolve?.pipe?.(node.attrs) || node.attrs.fallback || ''}</Fragment>;
      case 'var':
        return <Fragment key={i}>{resolve?.var?.(node.attrs) || node.attrs.fallback || ''}</Fragment>;
    }
  });
}

/** An empty line keeps its height, as it does in the editor. */
function Line({ nodes, resolve }: { nodes: readonly InlineNode[] | undefined; resolve: RichTextResolvers | undefined }) {
  return nodes?.length ? <Inline nodes={nodes} resolve={resolve} /> : <br />;
}

const alignStyle = (align: string | undefined): CSSProperties | undefined => (align ? { textAlign: align as CSSProperties['textAlign'] } : undefined);

function Item({ node, resolve }: { node: ListItemNode; resolve: RichTextResolvers | undefined }) {
  return <li>{node.content.map((child, i) => <Block key={i} node={child} resolve={resolve} />)}</li>;
}

function Block({ node, resolve }: { node: RichBlockNode; resolve: RichTextResolvers | undefined }) {
  switch (node.type) {
    case 'paragraph':
      return <p style={alignStyle(node.attrs?.align)}><Line nodes={node.content} resolve={resolve} /></p>;
    case 'heading': {
      const Tag = (['h1', 'h2', 'h3'] as const)[node.attrs.level - 1] ?? 'h3';
      return <Tag style={alignStyle(node.attrs.align)}><Line nodes={node.content} resolve={resolve} /></Tag>;
    }
    case 'bulletList':
      return <ul>{node.content.map((item, i) => <Item key={i} node={item} resolve={resolve} />)}</ul>;
    case 'orderedList':
      return <ol start={node.attrs?.start}>{node.content.map((item, i) => <Item key={i} node={item} resolve={resolve} />)}</ol>;
    case 'blockquote':
      return <blockquote>{node.content.map((child, i) => <Block key={i} node={child} resolve={resolve} />)}</blockquote>;
    case 'horizontalRule':
      return <hr />;
    case 'image': {
      const src = resolve?.asset?.(node.attrs.asset);
      if (!src) return null;
      const asset = node.attrs.asset;
      const alt = 'assetId' in asset && !asset.decorative ? asset.alt ?? '' : '';
      const img = <img src={src} alt={alt} style={{ width: node.attrs.widthPct ? `${node.attrs.widthPct}%` : undefined }} />;
      const href = node.attrs.href;
      return (
        <figure style={alignStyle(node.attrs.align)}>
          {href && isSafeUrl(href) ? <a href={href} rel={LINK_REL} target="_blank">{img}</a> : img}
        </figure>
      );
    }
  }
}

/**
 * Rich text as React elements: a switch over the AST node types, never an HTML string. Links get `rel` and `target`
 * here (they are not stored); pipes and template variables go through `resolve`.
 */
export function RichTextView({ doc, inline = false, resolve }: RichTextViewProps) {
  if (inline) return <Inline nodes={normalizeInlineDoc(doc).content[0].content} resolve={resolve} />;
  return doc.content.map((node, i) => <Block key={i} node={node} resolve={resolve} />);
}
