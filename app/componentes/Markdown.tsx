"use client";

import { useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(text);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      // clipboard indisponível (ex: contexto não seguro) — ignora
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg bg-neutral-900 text-neutral-100">
      <div className="flex items-center justify-between px-3 py-1 text-xs text-neutral-400">
        <span>{lang || "código"}</span>
        <button
          type="button"
          onClick={copiar}
          className="rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-white"
        >
          {copiado ? "Copiado!" : "Copiar"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 pb-3 text-sm">
        <code>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-3 mb-2 text-lg font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-2 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-black/20 pl-3 text-black/70 italic dark:border-white/20 dark:text-white/70">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-black/10 dark:border-white/10" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-black/5 dark:bg-white/10">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-black/10 px-3 py-2 text-left font-semibold whitespace-nowrap dark:border-white/10">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-black/5 px-3 py-2 align-top dark:border-white/5">
      {children}
    </td>
  ),
  code: ({ className, children, ...props }) => (
    <code
      className={`rounded bg-black/10 px-1 py-0.5 text-[0.85em] dark:bg-white/10 ${className ?? ""}`}
      {...props}
    >
      {children}
    </code>
  ),
  // Blocos de código (```lang ... ```) chegam aqui como <pre><code class="language-x">.
  // Extraímos o texto puro do filho para desenhar nosso próprio bloco com botão de copiar,
  // em vez de deixar o <code> acima (estilo inline) vazar para dentro do bloco.
  pre: ({ children }) => {
    const codeEl = children as ReactElement<{
      className?: string;
      children?: ReactNode;
    }> | null;
    const className = codeEl?.props?.className ?? "";
    const text = String(codeEl?.props?.children ?? "").replace(/\n$/, "");
    const lang = /language-(\w+)/.exec(className)?.[1];
    return <CodeBlock lang={lang} text={text} />;
  },
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
